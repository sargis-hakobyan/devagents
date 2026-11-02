import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Command, Id, ScopedPath } from '../../src/domain/schemas.js';
import { outputJsonSchema, modelSchemas, PlanningOutput, ReviewOutput } from '../../src/orchestration/outputs.js';

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

test('review output schema still generates for the model and rejects a rejection without findings locally', () => {
  const schema = outputJsonSchema(ReviewOutput) as z.core.JSONSchema.ObjectSchema;
  // `limitations` is generated for the model (reported checks that could not run) but a response without it still parses locally.
  assert.deepEqual(schema.required, ['approved', 'summary', 'findings', 'limitations']);
  assert.equal(ReviewOutput.safeParse({ approved: true, summary: 'ok', findings: [] }).success, true);
  assert.deepEqual(ReviewOutput.parse({ approved: true, summary: 'ok', findings: [] }).limitations, []);
  assert.equal(ReviewOutput.safeParse({ approved: false, summary: 'needs work', findings: ['Fix x'] }).success, true);
  assert.equal(ReviewOutput.safeParse({ approved: false, summary: 'needs work', findings: [] }).success, false);
});

/** OpenAI strict structured output rejects any object whose `required` omits a property. Walk every model-facing schema. */
function assertStrict(schema: Record<string, unknown>, path = '$'): void {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties) {
    assert.equal(schema.additionalProperties, false, `${path}: additionalProperties`);
    assert.deepEqual([...(schema.required as string[] ?? [])].sort(), Object.keys(properties).sort(), `${path}: every property must be required`);
    for (const [key, child] of Object.entries(properties)) assertStrict(child, `${path}.${key}`);
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf'] as const) {
    const value = schema[key];
    if (Array.isArray(value)) value.forEach((child, i) => assertStrict(child as Record<string, unknown>, `${path}.${key}[${i}]`));
    else if (value && typeof value === 'object') assertStrict(value as Record<string, unknown>, `${path}.${key}`);
  }
  // Objects moved behind references must satisfy the same rule.
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = schema[key] as Record<string, Record<string, unknown>> | undefined;
    if (defs) for (const [name, child] of Object.entries(defs)) assertStrict(child, `${path}.${key}.${name}`);
  }
}
test('every registered model schema lists all properties as required, as strict structured output demands', () => {
  const inventory = modelSchemas();
  assert.deepEqual(Object.keys(inventory).sort(), ['connectionCheck', 'implementation', 'planning', 'review', 'setup'], 'a new model call site must register its schema here');
  for (const [name, schema] of Object.entries(inventory)) assertStrict(schema, name);
  const planning = outputJsonSchema(PlanningOutput) as z.core.JSONSchema.ObjectSchema;
  assert.ok((planning.required as string[]).includes('manualChecks'));
  assert.ok((inventory.setup!.required as string[]).includes('limitations'), 'setup reports must also use strict structured output');
  // The walker itself catches an optional property hidden behind a definition.
  assert.throws(() => assertStrict({ type: 'object', properties: { a: { $ref: '#/$defs/inner' } }, required: ['a'], additionalProperties: false, $defs: { inner: { type: 'object', properties: { x: { type: 'string' } }, required: [], additionalProperties: false } } }), /must be required/);
});
