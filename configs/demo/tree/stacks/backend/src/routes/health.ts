import { Router } from 'express'

export const health = Router()

health.get('/', (_request, response) => response.json({ status: 'ok', service: '{{name}}' }))
