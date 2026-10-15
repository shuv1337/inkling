-- Full-text search over a shelf row. The input is capped because a tsvector
-- cannot hold a whole book, and a failed insert would reject the text.
alter table articles add column if not exists search tsvector
  generated always as (
    to_tsvector(
      'english',
      left(
        coalesce(data->>'title', '') || ' ' ||
        coalesce(data->>'author', '') || ' ' ||
        coalesce(data->>'source', '') || ' ' ||
        coalesce(doc::text, ''),
        500000
      )
    )
  ) stored;

create index if not exists articles_search_idx on articles using gin (search);
