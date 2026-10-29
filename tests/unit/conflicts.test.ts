import test from 'node:test';
import assert from 'node:assert/strict';
import { countSeparators, unresolvedMarkers } from '../../src/workspace/conflicts.js';

test('conflict detection accepts Markdown heading underlines but not leftover markers or extra separators', () => {
  const heading = 'Notes\n=======\n\nResolved text.\n';
  assert.equal(countSeparators(heading), 1);
  assert.equal(unresolvedMarkers(heading, 1), undefined);
  assert.equal(unresolvedMarkers('Plain file\n', 0), undefined);
  // A separator the sides never had is a leftover conflict divider even without the other markers.
  assert.match(unresolvedMarkers('Notes\n=======\nours\n=======\ntheirs\n', 1)!, /conflict separator \(2 "=======" lines, at most 1/);
  assert.match(unresolvedMarkers('ours\n=======\ntheirs\n', 0)!, /conflict separator/);
  // Any start, base or end marker is unresolved regardless of separators, including lengthened markers.
  assert.equal(unresolvedMarkers('<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n', 5), 'conflict marker');
  assert.equal(unresolvedMarkers('<<<<<<<<<<<< ours\na\n============\nb\n>>>>>>>>>>>> theirs\n', 5), 'conflict marker');
  assert.equal(unresolvedMarkers('a\n||||||| base\nb\n', 0), 'conflict marker');
  assert.equal(unresolvedMarkers('text\n>>>>>>> theirs\n', 0), 'conflict marker');
  // Lines that merely resemble markers are not markers.
  assert.equal(unresolvedMarkers('<<<<<<<x not a marker without a following space\n====== six\n>>>>>> six\n', 0), undefined);
});
