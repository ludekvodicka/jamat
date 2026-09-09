export function Banner({ message }: { message: string }) {
  return (
    <aside className="banner" role="status">
      {message}
    </aside>
  )
}
