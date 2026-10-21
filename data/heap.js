'use strict';
/**
 * Binary heap: the priority queue behind Smart Call Next (data/dispatch.js).
 *
 * A complete binary tree kept in an array: the children of index i are
 * 2i + 1 and 2i + 2, its parent is (i - 1) >> 1. Every parent comes before
 * its children by `before(a, b)`, so the client to call next is always at
 * index 0.
 *
 *   peek     the top, O(1)
 *   push     add at the end, sift up,   O(log n)
 *   pop      take the top, move the last to the top, sift down, O(log n)
 *   from     build from a whole lane at once (heapify, bottom up), O(n)
 *
 * `before(a, b)` is true when a must be called before b.
 */
class BinaryHeap {
  constructor(before) {
    this.before = before;
    this.items = [];
  }

  /** Builds a heap from a list in O(n): sift down every parent, last one first. */
  static from(list, before) {
    const h = new BinaryHeap(before);
    h.items = list.slice();
    for (let i = (h.items.length >> 1) - 1; i >= 0; i--) h.siftDown(i);
    return h;
  }

  get size() { return this.items.length; }
  peek() { return this.items[0]; }

  push(x) {
    this.items.push(x);
    this.siftUp(this.items.length - 1);
  }

  pop() {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0], last = a.pop();
    if (a.length) { a[0] = last; this.siftDown(0); }
    return top;
  }

  /** The first k in calling order, leaving the heap as it was. */
  top(k) {
    const copy = BinaryHeap.from(this.items, this.before), out = [];
    while (out.length < k && copy.size) out.push(copy.pop());
    return out;
  }

  siftUp(i) {
    const a = this.items;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.before(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  siftDown(i) {
    const a = this.items, n = a.length;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && this.before(a[l], a[m])) m = l;
      if (r < n && this.before(a[r], a[m])) m = r;
      if (m === i) return;
      [a[i], a[m]] = [a[m], a[i]];
      i = m;
    }
  }
}

module.exports = { BinaryHeap };
