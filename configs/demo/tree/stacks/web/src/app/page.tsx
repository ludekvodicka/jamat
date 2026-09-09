import { Banner } from '../components/banner'
import { Hero } from '../components/hero'

export default function Home() {
  return (
    <main>
      <Banner message="Free delivery on orders over 50." />
      <Hero title="{{name}}" subtitle="{{description}}" />
    </main>
  )
}
