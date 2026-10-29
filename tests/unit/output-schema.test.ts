import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Command, Id, ScopedPath } from '../../src/domain/schemas.js';
import { outputJsonSchema } from '../../src/orchestration/outputs.js';

test('model schema omits the incompatible path regex without weakening local path validation', () => {
  const schema = z.strictObject({ id: Id, ownedPaths: z.array(ScopedPath).min(1), validation: z.array(Command) });
  const output = outputJsonSchema(schema) as z.core.JSONSchema.ObjectSchema;
  const properties = output.properties!;
  const paths = properties.ownedPaths as z.core.JSONSchema.ArraySchema;
  const path = paths.items as z.core.JSONSchema.StringSchema;
  assert.equal(output.$schema, undefined);
  assert.equal(output.additionalProperties, false);
  assert.deepEqual(output.required, ['id', 'ownedPaths', 'validation']);
  assert.equal(paths.minItems, 1);
  assert.equal(path.type, 'string');
  assert.equal(path.pattern, undefined);
  assert.match(path.description!, /project:\//);
  assert.equal((properties.id as z.core.JSONSchema.StringSchema).pattern, z.toJSONSchema(Id).pattern);
  assert.equal(JSON.stringify(output).includes('"default"'), false);
  assert.equal(ScopedPath.safeParse('project:/src/a.ts').success, true);
  assert.equal(ScopedPath.safeParse('project:/../secret').success, false);
  assert.equal(ScopedPath.safeParse('project:/bad\0name').success, false);
  assert.equal(z.toJSONSchema(ScopedPath).pattern, /^project:\/(?:[^\\\0]*)$/.source);
});
