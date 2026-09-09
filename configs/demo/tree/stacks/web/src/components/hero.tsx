export function Hero({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="hero">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </section>
  )
}
