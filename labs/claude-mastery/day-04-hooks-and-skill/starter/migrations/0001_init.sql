-- 由 pnpm db:generate 生成，不要手改。演示项目只用内存存储，这个文件是给 hook 当靶子的。
create table todos (
  id text primary key,
  title text not null,
  done boolean not null default false,
  due_at timestamptz
);
