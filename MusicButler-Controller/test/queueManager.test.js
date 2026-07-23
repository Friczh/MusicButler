import { queueManager } from '../src/queue/queueManager.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('PASS:', msg);
}

// --- add / list ---
queueManager.add({ videoId: 'A', title: 'Track A' });
queueManager.add({ videoId: 'B', title: 'Track B' });
queueManager.add({ videoId: 'C', title: 'Track C' });
assert(queueManager.queue.length === 3, 'add() grows queue to 3');

// --- remove position 0 blocked ---
let r = queueManager.remove(0);
assert(r.error === true && r.message.includes('/skip'), 'remove(0) blocked with skip message');

// --- remove invalid position ---
r = queueManager.remove(99);
assert(r.error === true, 'remove(99) invalid position rejected');

// --- remove valid ---
r = queueManager.remove(2); // removes Track B
assert(r.error === false && r.removed.videoId === 'B', 'remove(2) removes correct track');
assert(queueManager.queue.length === 2, 'queue shrinks after remove');
assert(queueManager.queue[0].videoId === 'A' && queueManager.queue[1].videoId === 'C', 'remaining order correct after remove');

// reset
queueManager.clear();
queueManager.add({ videoId: 'A', title: 'A' });
queueManager.add({ videoId: 'B', title: 'B' });
queueManager.add({ videoId: 'C', title: 'C' });

// --- swap position 0 blocked ---
r = queueManager.swap(0, 1);
assert(r.error === true, 'swap(0, x) blocked');
r = queueManager.swap(1, 0);
assert(r.error === true, 'swap(x, 0) blocked');

// --- swap valid ---
r = queueManager.swap(1, 3); // A<->C
assert(r.error === false, 'swap(1,3) succeeds');
assert(queueManager.queue[0].videoId === 'C' && queueManager.queue[2].videoId === 'A', 'swap(1,3) actually swapped');

// reset
queueManager.clear();
queueManager.add({ videoId: 'A', title: 'A' });
queueManager.add({ videoId: 'B', title: 'B' });
queueManager.add({ videoId: 'C', title: 'C' });
queueManager.add({ videoId: 'D', title: 'D' });

// --- move position 0 blocked ---
r = queueManager.move(0, 2);
assert(r.error === true, 'move(0, x) blocked');

// --- move valid: [A,B,C,D] move 4->1 => [D,A,B,C] ---
r = queueManager.move(4, 1);
assert(r.error === false && r.track.videoId === 'D', 'move(4,1) moves correct track');
assert(
  queueManager.queue.map(t => t.videoId).join('') === 'DABC',
  `move(4,1) produces DABC order (got ${queueManager.queue.map(t => t.videoId).join('')})`
);

// --- move invalid ---
r = queueManager.move(1, 99);
assert(r.error === true, 'move with out-of-range "to" rejected');

// --- advance ---
queueManager.clear();
queueManager.add({ videoId: 'X', title: 'X' });
const next = queueManager.advance();
assert(next.videoId === 'X', 'advance() pulls first track as nowPlaying');
assert(queueManager.queue.length === 0, 'advance() empties queue after taking last item');
assert(queueManager.advance() === null, 'advance() on empty queue returns null');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
