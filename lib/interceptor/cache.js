'use strict'

const assert = require('node:assert')
const util = require('../core/util')
const CacheHandler = require('../handler/cache-handler')
const MemoryCacheStore = require('../cache/memory-cache-store')
const CacheRevalidationHandler = require('../handler/cache-revalidation-handler')
const { assertCacheStore, assertCacheMethods, makeCacheKey } = require('../util/cache.js')

const AGE_HEADER = Buffer.from('age')

/**
 * @typedef {import('../../types/cache-interceptor.d.ts').default.CachedResponse} CachedResponse
 */

/**
 * @param {import('../../types/cache-interceptor.d.ts').default.CacheOptions} [opts]
 * @returns {import('../../types/dispatcher.d.ts').default.DispatcherComposeInterceptor}
 */
module.exports = (opts = {}) => {
  const {
    store = new MemoryCacheStore(),
    methods = ['GET']
  } = opts

  if (typeof opts !== 'object' || opts === null) {
    throw new TypeError(`expected type of opts to be an Object, got ${opts === null ? 'null' : typeof opts}`)
  }

  assertCacheStore(store, 'opts.store')
  assertCacheMethods(methods, 'opts.methods')

  const globalOpts = {
    store,
    methods
  }

  const safeMethodsToNotCache = util.safeHTTPMethods.filter(method => methods.includes(method) === false)

  return dispatch => {
    return (opts, handler) => {
      // TODO (fix): What if e.g. opts.headers has if-modified-since header? Or other headers
      // that make things ambigious?

      if (!opts.origin || safeMethodsToNotCache.includes(opts.method)) {
        // Not a method we want to cache or we don't have the origin, skip
        return dispatch(opts, handler)
      }

      /**
       * @type {import('../../types/cache-interceptor.d.ts').default.CacheKey}
       */
      const cacheKey = makeCacheKey(opts)

      // TODO (perf): For small entries support returning a Buffer instead of a stream.
      // Maybe store should return { staleAt, headers, body, etc... } instead of a stream + stream.value?
      // Where body can be a Buffer, string, stream or blob?
      const result = store.get(cacheKey)
      if (!result) {
        // Request isn't cached
        return dispatch(opts, new CacheHandler(globalOpts, cacheKey, handler))
      }

      /**
       * @param {import('node:stream').Readable | undefined} stream
       * @param {import('../../types/cache-interceptor.d.ts').default.CachedResponse} value
       */
      const respondWithCachedValue = (stream, value) => {
        assert(!stream || !stream.destroyed, 'stream should not be destroyed')
        assert(!stream || !stream.readableDidRead, 'stream should not be readableDidRead')
        try {
          stream
            ?.on('error', function (err) {
              if (!this.readableEnded) {
                if (typeof handler.onError === 'function') {
                  handler.onError(err)
                } else {
                  process.nextTick(() => {
                    throw err
                  })
                }
              }
            })
            .on('close', function () {
              if (!this.errored && typeof handler.onComplete === 'function') {
                handler.onComplete([])
              }
            })

          if (typeof handler.onConnect === 'function') {
            handler.onConnect((err) => {
              stream?.destroy(err)
            })

            if (stream?.destroyed) {
              return
            }
          }

          if (typeof handler.onHeaders === 'function') {
            // Add the age header
            // https://www.rfc-editor.org/rfc/rfc9111.html#name-age
            const age = Math.round((Date.now() - value.cachedAt) / 1000)

            // TODO (fix): What if rawHeaders already contains age header?
            const rawHeaders = [...value.rawHeaders, AGE_HEADER, Buffer.from(`${age}`)]

            if (handler.onHeaders(value.statusCode, rawHeaders, () => stream?.resume(), value.statusMessage) === false) {
              stream?.pause()
            }
          }

          if (opts.method === 'HEAD') {
            if (typeof handler.onComplete === 'function') {
              handler.onComplete([])
            }

            stream?.destroy()
          } else {
            stream.on('data', function (chunk) {
              if (typeof handler.onData === 'function' && !handler.onData(chunk)) {
                stream.pause()
              }
            })
          }
        } catch (err) {
          stream?.destroy(err)
        }
      }

      /**
       * @param {import('../../types/cache-interceptor.d.ts').default.GetResult} result
       */
      const handleStream = (result) => {
        const { response: value, body: stream } = result

        if (!stream && opts.method !== 'HEAD') {
          throw new Error('stream is undefined but method isn\'t HEAD')
        }

        // Check if the response is stale
        const now = Date.now()
        if (now < value.staleAt) {
          // Dump request body.
          if (util.isStream(opts.body)) {
            opts.body.on('error', () => {}).destroy()
          }
          respondWithCachedValue(stream, value)
        } else if (util.isStream(opts.body) && util.bodyLength(opts.body) !== 0) {
          // If body is is stream we can't revalidate...
          // TODO (fix): This could be less strict...
          dispatch(opts, new CacheHandler(globalOpts, cacheKey, handler))
        } else {
          // Need to revalidate the response
          dispatch(
            {
              ...opts,
              headers: {
                ...opts.headers,
                'if-modified-since': new Date(value.cachedAt).toUTCString()
              }
            },
            new CacheRevalidationHandler(
              (success) => {
                if (success) {
                  respondWithCachedValue(stream, value)
                } else {
                  stream.on('error', () => {}).destroy()
                }
              },
              new CacheHandler(globalOpts, cacheKey, handler)
            )
          )
        }
      }

      if (typeof result.then === 'function') {
        result.then((result) => {
          if (!result) {
            // Request isn't cached
            return dispatch(opts, new CacheHandler(globalOpts, cacheKey, handler))
          }

          handleStream(result)
        }).catch(err => handler.onError(err))
      } else {
        handleStream(result)
      }

      return true
    }
  }
}