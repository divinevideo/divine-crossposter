import { Hono } from 'hono'
import { listPreferenceSummaries, updatePreference } from '../services/connections'
import type { Env } from '../types'
import { errorResponse, jsonResponse } from '../utils/http'

export const preferences = new Hono<{ Bindings: Env }>()

preferences.get('/preferences', async (c) => {
  try {
    return jsonResponse({ preferences: await listPreferenceSummaries(c.req.raw, c.env) })
  } catch (error) {
    return errorResponse(error)
  }
})

preferences.put('/preferences/:platform', async (c) => {
  try {
    const body = (await c.req.raw.clone().json().catch(() => ({}))) as { mode?: unknown }
    return jsonResponse({ preference: await updatePreference(c.req.raw, c.env, c.req.param('platform'), body.mode) })
  } catch (error) {
    return errorResponse(error)
  }
})
