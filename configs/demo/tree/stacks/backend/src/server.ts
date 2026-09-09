import express from 'express'
import { health } from './routes/health.js'

const app = express()
app.use(express.json())
app.use('/health', health)

const port = Number(process.env.PORT ?? 4000)
app.listen(port, () => console.log('{{name}} listening on :' + port))
