import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { oooResult } from './ooo-result.mjs';

describe('OOO JSON outcome', () => {
  it('exposes named creations and deletions with both priority counter names', () => {
    const stats = {
      created: 2,
      deleted: 1,
      prioritySet: 3,
      createdNames: ['Conference', 'Another trip'],
      deletedNames: ['Cancelled trip']
    };
    assert.deepEqual(JSON.parse(JSON.stringify(oooResult(stats))), {
      created: 2,
      deleted: 1,
      setToP2: 3,
      prioritySet: 3,
      createdNames: ['Conference', 'Another trip'],
      deletedNames: ['Cancelled trip']
    });
  });

  it('retains explicit empty name arrays and legacy zero counts', () => {
    assert.deepEqual(oooResult({ created: 0, deleted: 0, prioritySet: 0, createdNames: [], deletedNames: [] }), {
      created: 0,
      deleted: 0,
      setToP2: 0,
      prioritySet: 0,
      createdNames: [],
      deletedNames: []
    });
  });

  it('captures the completed names independently of later notification mutations', () => {
    const stats = { created: 1, deleted: 0, prioritySet: 0, createdNames: ['Trip "A"\nSecond line'], deletedNames: [] };
    const result = oooResult(stats);
    stats.createdNames[0] = 'Changed after sync';
    assert.deepEqual(JSON.parse(JSON.stringify(result)).createdNames, ['Trip "A"\nSecond line']);
  });
});
