import { Hono } from 'hono'
import {
  completeConnectionCallback,
  disconnectOwnedConnection,
  listConnectionSummaries,
  startConnection,
} from '../services/connections'
import type { Env } from '../types'
import { errorResponse, jsonResponse } from '../utils/http'

export const connections = new Hono<{ Bindings: Env }>()

connections.get('/connections', async (c) => {
  try {
    return jsonResponse({ connections: await listConnectionSummaries(c.req.raw, c.env) })
  } catch (error) {
    return errorResponse(error)
  }
})

connections.post('/connections/:platform/start', async (c) => {
  try {
    const body = (await c.req.raw.clone().json().catch(() => ({}))) as { returnUrl?: unknown }
    return jsonResponse(await startConnection(c.req.raw, c.env, c.req.param('platform'), body.returnUrl))
  } catch (error) {
    return errorResponse(error)
  }
})

connections.get('/connections/:platform/callback', async (c) => {
  const url = new URL(c.req.url)
  const redirectUrl = await completeConnectionCallback(
    c.env,
    c.req.param('platform'),
    url.searchParams.get('code'),
    url.searchParams.get('state'),
    url.searchParams.get('error'),
    url.searchParams.get('error_reason'),
  )
  return c.redirect(redirectUrl)
})

connections.delete('/connections/:platform/:connection_id', async (c) => {
  try {
    return jsonResponse(
      await disconnectOwnedConnection(c.req.raw, c.env, c.req.param('platform'), c.req.param('connection_id')),
    )
  } catch (error) {
    return errorResponse(error)
  }
})
