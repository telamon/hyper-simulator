module.exports = class Scheduler {
  constructor (a = true) {
    this._async = a
    this.head = null
    this.tail = null
    this.lastTick = -1
  }

  get empty () { return !this.head }

  enque (at, fn) {
    if (at < this.lastTick) throw new Error('Cannot enqueue backwards in time')

    if (!this.head || this.head.at >= at) {
      // O(1) prepend on empty || first
      this.head = { at, fn, next: this.head }
      if (!this.tail) this.tail = this.head
      return this.cancel.bind(this, this.head)
    } else if (this.tail && this.tail.at <= at) {
      // O(1) append when timestamp is higher than last element.
      this.tail = this.tail.next = { at, fn, next: null }
      return this.cancel.bind(this, this.tail)
    } else { // O(log n) insert...
      let ev = this.head
      do {
        if (ev.at < at && ev.next.at > at) {
          ev.next = { at, fn, next: ev.next }
          return this.cancel.bind(this, ev.next)
        }
      } while ((ev = ev.next))
      throw new Error('Invalid state')
    }
  }

  // O(1) event lookup
  tick (time) {
    if (this.lastTick > time) throw new Error('Time must increment each tick')
    this.lastTick = time
    if (this.empty || this.time < this.head.at) return
    this._invoke(this.head.fn) // Invoke userFn
    this.head = this.head.next
    this.tick(time)
  }

  deltaTick (delta) {
    return this.tick(this.lastTick + delta)
  }

  _invoke (userFn) {
    if (this._async) process.nextTick(userFn)
    else userFn()
  }

  cancel (ev) {
    if (ev.canceled) return false
    ev.canceled = true
    let c = this.head
    do {
      if (c.next === ev) {
        c.next = ev.next
        if (this.tail === ev) this.tail = c // update tail if needed
        return true
      }
    } while ((c = c.next))
  }

  toArray () {
    const list = []
    let ev = this.head
    do list.push(ev)
    while ((ev = ev.next))
    return list
  }

  /** Familiar interface */
  setTimeout (userFn, timeout) {
    if (typeof timeout !== 'number' || isNaN(timeout) || timeout < 1) return this._invoke(userFn)
    return this.enque(this.lastTick + timeout, userFn)
  }
}
