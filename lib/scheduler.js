module.exports = class Scheduler {
  constructor () {
    this.head = null
    this.tail = null
    this.lastTick = -1
  }

  get empty () { return !this.head }

  enque (at, fn) {
    if (!this.head || this.head.at >= at) {
      // O(1) prepend on empty
      this.head = { at, fn, next: this.head }
      if (!this.tail) this.tail = this.head
      return this.cancel.bind(this, this.head)
    } else if (this.tail && this.tail.at <= at) {
      // O(1) append when timestamp is higher than last element.
      this.tail = this.tail.next = { at, fn, next: null }
      return this.cancel.bind(this, this.tail)
    } else if (this.head.at < this.lastTick) {
      return false // don't mem-leak
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

  tick (time) {
    if (this.lastTick > time) return
    this.lastTick = time
    if (this.empty || this.time < this.head.at) return
    this.head.fn() // Invoke userFn
    this.head = this.head.next
    this.tick(time)
  }

  // Todo
  cancel (ev) {
    if (ev.canceled) return
    ev.canceled = true
    let c = this.head
    do {
      if (c.next === ev) {
        c.next = ev.next
        if (this.tail === ev) this.tail = c // update tail if needed
        return
      }
    }
    while ((c = c.next))
  }

  toArray () {
    const list = []
    let ev = this.head
    do list.push(ev)
    while ((ev = ev.next))
    return list
  }
}
