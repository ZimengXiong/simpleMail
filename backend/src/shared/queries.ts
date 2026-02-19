export const updateSearchVector = `
CREATE OR REPLACE FUNCTION messages_search_vector_set() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.from_header, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.to_header, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.body_text, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.body_html, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`; 
