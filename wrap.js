var PullCont = require('pull-cont')
var pull = require('pull-stream')

module.exports = function wrap(sv, flume) {
  var since = flume.since, isReady = flume.ready
  var waiting = []

  var meta = {}

  function throwIfClosed(name) {
    if(flume.closed) throw new Error('cannot call:'+name+', flumedb instance closed')
  }

  sv.since(function (upto) {
    if(!isReady.value) return
    while(waiting.length && waiting[0].seq <= upto)
      waiting.shift().cb()
  })

  isReady(function (ready) {
    if(!ready) return
    var upto = sv.since.value
    if(upto == undefined) return
    while(waiting.length && waiting[0].seq <= upto)
      waiting.shift().cb()
  })

  function ready (cb, after) {
    //view is already up to date with log, we can just go.
    if(isReady.value && since.value != null && since.value === sv.since.value)  
      cb()
    //use since: -1 to say you don't care about waiting. just give anything.
    //we still want to wait until the view has actually loaded. but it doesn't
    //need to be compared to the log's value.
    else if(after < 0) {
      sv.since.once(cb)
    }
    else if(after) {
      if(!waiting.length || waiting[waiting.length - 1].seq <= after)
        waiting.push({seq: after, cb: cb})
      else {
        //find the right point to insert this value.
        for(var i = waiting.length - 2; i > 0; i--) {
          waiting[i].seq <= after
          waiting.splice({seq: after, cb: cb}, i+1, 0)
        }
      }
    } else {
      since.once(function (upto) {
        if(flume.closed) cb(new Error('flumedb: closed before log ready'))
        else if(isReady.value && upto === sv.since.value) cb()
        else waiting.push({seq: upto, cb: cb})
      })
    }
  }

  var wrapper = {
    source: function (fn, name) {
      return function (opts) {
        throwIfClosed(name)
        meta[name] ++
        return pull(PullCont(function (cb) {
          ready(function () { cb(null, fn(opts)) }, opts && opts.since)
        }), pull.through(function () { meta[name] ++ }))
      }
    },
    async: function (fn, name) {
      return function (opts, cb) {
        throwIfClosed(name)
        meta[name] ++
        ready(function () {
          fn(opts, cb)
        }, opts && opts.since)
      }
    },
    sync: function (fn, name) {
      return function (a, b) {
        throwIfClosed(name)
        meta[name] ++
        return fn(a, b)
      }
    }
  }

  function _close (err) {
    while(waiting.length)
      waiting.shift().cb(err)
  }

  var o = {
    name: sv.name,
    abortable: sv.abortable,
    createSink: sv.createSink,
    ready: ready,
    since: sv.since,
    close: function (err, cb) {
      if('function' == typeof err)
        cb = err, err = null
      _close(err || new Error('flumedb:view closed'))
      if(sv.close.length == 1) sv.close(cb)
      else                     sv.close(err, cb)
    },
    meta: meta,
    destroy: sv.destroy
  }
  if(!sv.methods) throw new Error('a stream view must have methods property')

  for(var key in sv.methods) {
    var type = sv.methods[key]
    var fn = sv[key]
    if(typeof fn !== 'function') throw new Error('expected function named:'+key+'of type: '+type)
    //type must be either source, async, or sync
    meta[key] = 0
    o[key] = wrapper[type](fn, key)
  }

  o.methods = sv.methods
  return o
}
