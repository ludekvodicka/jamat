// The renderer imports stylesheets for their side effect; the bundler turns each one into an
// injected <style>. Declared here rather than by pulling in vite/client, which would drop a much
// larger ambient surface into a program that needs exactly this.
declare module '*.css' {
  const stylesheet: string
  export default stylesheet
}
