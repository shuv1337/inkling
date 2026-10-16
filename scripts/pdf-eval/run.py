"""
PDF eval: how well does each reader turn hard PDF pages into Markdown?

Contenders, per page:
  text-layer        the PDF's own text layer (what a plain extractor like pdf.js gets; nothing on scans)
  qwen3.5-9b        Qwen/Qwen3.5-9B on Together, reading a rendered image of the page
  llamaparse-cost   LlamaParse, tier "cost_effective"
  llamaparse-agent  LlamaParse, tier "agentic"

For each page it records the Markdown, seconds and dollars, renders the page to PNG for judging,
and writes out/<page>/... plus out/summary.json. Quality is judged separately (blind), from out/.

Pages are in pages.json; "scan": true pages are turned into image-only PDFs first (rotated,
noisy, JPEG-compressed), the way a phone or office scanner would make them.

Needs: pip install pymupdf requests; TOGETHER_API_KEY and LLAMA_CLOUD_API_KEY in the environment.
  python scripts/pdf-eval/run.py [outdir]
"""

import base64, io, json, os, random, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pymupdf
import requests

HERE = Path(__file__).parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "out"
CFG = json.loads((HERE / "pages.json").read_text())
TOGETHER = os.environ["TOGETHER_API_KEY"]
LLAMA = os.environ["LLAMA_CLOUD_API_KEY"]
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36"

QWEN = "Qwen/Qwen3.5-9B"
QWEN_IN, QWEN_OUT = 0.17, 0.25  # $ per million tokens, Together, 2026-10-10
LLAMA_CREDIT = 0.00125  # $ per credit
PROMPT = (
    "Convert this page to Markdown. Keep the reading order (read columns top to bottom, left column first), "
    "headings as #, lists, tables as Markdown tables, and maths as LaTeX between $ signs. "
    "Leave out page headers, footers and page numbers. Describe a figure in one line as [Figure: ...]. "
    "Output only the Markdown."
)


def fetch_docs():
    docs = {}
    cache = OUT / "_pdfs"
    cache.mkdir(parents=True, exist_ok=True)
    for name, url in CFG["docs"].items():
        f = cache / f"{name}.pdf"
        if not f.exists():
            r = requests.get(url, headers={"User-Agent": UA}, timeout=60)
            r.raise_for_status()
            f.write_bytes(r.content)
        docs[name] = pymupdf.open(f)
    return docs


def one_page_pdf(doc, page, scan):
    """The page alone as a PDF; for a scan, a slightly rotated, noisy, JPEG-compressed picture of it."""
    single = pymupdf.open()
    single.insert_pdf(doc, from_page=page, to_page=page)
    if not scan:
        return single.tobytes()
    pix = single[0].get_pixmap(dpi=150, colorspace=pymupdf.csGRAY)
    from PIL import Image, ImageFilter  # noqa: PLC0415 (only scans need Pillow)

    img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    rnd = random.Random(7)
    img = img.rotate(0.8, resample=Image.BICUBIC, fillcolor=245).filter(ImageFilter.GaussianBlur(0.6))
    px = img.load()
    for _ in range(img.width * img.height // 60):
        x, y = rnd.randrange(img.width), rnd.randrange(img.height)
        px[x, y] = max(0, min(255, px[x, y] + rnd.randint(-60, 60)))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=55)
    out = pymupdf.open()
    rect = single[0].rect
    p = out.new_page(width=rect.width, height=rect.height)
    p.insert_image(rect, stream=buf.getvalue())
    return out.tobytes()


def png_of(pdf_bytes, dpi):
    d = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    return d[0].get_pixmap(dpi=dpi).tobytes("png")


def text_layer(pdf_bytes):
    t0 = time.time()
    d = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    return {"markdown": d[0].get_text(), "seconds": time.time() - t0, "usd": 0.0}


def qwen(pdf_bytes):
    t0 = time.time()
    b64 = base64.b64encode(png_of(pdf_bytes, 130)).decode()
    body = {
        "model": QWEN,
        "max_tokens": 6000,
        "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}, {"type": "text", "text": PROMPT}]}],
    }
    r = requests.post("https://api.together.xyz/v1/chat/completions", json=body, headers={"Authorization": f"Bearer {TOGETHER}", "User-Agent": "Inkling/0.1"}, timeout=300)
    j = r.json()
    if "error" in j:
        return {"markdown": "", "error": j["error"].get("message", str(j["error"])), "seconds": time.time() - t0, "usd": 0.0}
    u = j.get("usage", {})
    usd = (u.get("prompt_tokens", 0) * QWEN_IN + u.get("completion_tokens", 0) * QWEN_OUT) / 1e6
    md = j["choices"][0]["message"].get("content") or ""
    return {"markdown": md, "seconds": time.time() - t0, "usd": usd, "finish": j["choices"][0].get("finish_reason")}


def llamaparse(pdf_bytes, tier):
    t0 = time.time()
    h = {"Authorization": f"Bearer {LLAMA}"}
    r = requests.post(
        "https://api.cloud.llamaindex.ai/api/v2/parse/upload",
        headers=h,
        files={"file": ("page.pdf", pdf_bytes, "application/pdf")},
        data={"configuration": json.dumps({"tier": tier, "version": "latest"})},
        timeout=120,
    )
    job = r.json().get("id")
    if not job:
        return {"markdown": "", "error": r.text[:300], "seconds": time.time() - t0, "usd": 0.0}
    status = "PENDING"
    while time.time() - t0 < 600:
        s = requests.get(f"https://api.cloud.llamaindex.ai/api/v2/parse/{job}", headers=h, timeout=60).json()
        status = s["job"]["status"]
        if status in ("COMPLETED", "FAILED", "CANCELLED"):
            break
        time.sleep(2)
    seconds = time.time() - t0
    if status != "COMPLETED":
        return {"markdown": "", "error": status, "seconds": seconds, "usd": 0.0}
    res = requests.get(f"https://api.cloud.llamaindex.ai/api/v2/parse/{job}?expand=markdown,usage", headers=h, timeout=60).json()
    pages = (res.get("markdown") or {}).get("pages") or []
    md = "\n\n".join(p.get("markdown", "") for p in pages)
    credits = ((res.get("job") or {}).get("usage") or {}).get("credits")
    return {"markdown": md, "seconds": seconds, "usd": (credits or 0) * LLAMA_CREDIT, "credits": credits}


READERS = {
    "text-layer": text_layer,
    "qwen3.5-9b": qwen,
    "llamaparse-cost": lambda b: llamaparse(b, "cost_effective"),
    "llamaparse-agent": lambda b: llamaparse(b, "agentic"),
}


# A request can stall without ever timing out (a socket that trickles); every reader gets a hard limit.
LIMIT = 180
POOL = ThreadPoolExecutor(max_workers=16)


def with_limit(fn, pdf):
    for attempt in range(2):
        fut = POOL.submit(fn, pdf)
        try:
            return fut.result(timeout=LIMIT)
        except Exception as e:  # timed out or failed: once more, then give up on this reader for this page
            err = "timed out" if isinstance(e, TimeoutError) else repr(e)[:300]
    return {"markdown": "", "error": err, "seconds": float(LIMIT), "usd": 0.0}


def run_page(spec, docs):
    folder = OUT / spec["id"]
    folder.mkdir(parents=True, exist_ok=True)
    done = folder / "result.json"
    if done.exists():  # finished in an earlier run
        return json.loads(done.read_text())
    pdf = one_page_pdf(docs[spec["doc"]], spec["page"], spec.get("scan", False))
    (folder / "page.pdf").write_bytes(pdf)
    (folder / "page.png").write_bytes(png_of(pdf, 110))
    futures = {name: POOL.submit(with_limit, fn, pdf) for name, fn in READERS.items()}
    results = {}
    for name, fut in futures.items():
        results[name] = fut.result()
        (folder / f"{name}.md").write_text(results[name]["markdown"])
    print(f"{spec['id']:20} " + "  ".join(f"{n} {r['seconds']:5.1f}s ${r['usd']:.4f}{' ERR' if r.get('error') else ''}" for n, r in results.items()), flush=True)
    row = {"id": spec["id"], "kind": spec["kind"], "scan": spec.get("scan", False), "results": {n: {k: v for k, v in r.items() if k != "markdown"} for n, r in results.items()}}
    done.write_text(json.dumps(row))
    return row


def main():
    docs = fetch_docs()
    # Pages three at a time; each page's four readers run side by side.
    with ThreadPoolExecutor(max_workers=3) as pages:
        rows = list(pages.map(lambda spec: run_page(spec, docs), CFG["pages"]))
    (OUT / "summary.json").write_text(json.dumps(rows, indent=2))
    POOL.shutdown(wait=False, cancel_futures=True)
    os._exit(0)  # a stalled request thread must not keep the run alive


if __name__ == "__main__":
    main()
