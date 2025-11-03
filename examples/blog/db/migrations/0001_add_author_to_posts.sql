ALTER TABLE posts ADD COLUMN author_id integer;
UPDATE posts SET author_id = 1 WHERE author_id IS NULL;
ALTER TABLE posts ALTER COLUMN author_id SET NOT NULL;
ALTER TABLE posts
  ADD CONSTRAINT posts_author_id_fkey
  FOREIGN KEY (author_id)
  REFERENCES users(id)
  ON DELETE RESTRICT;
