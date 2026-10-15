import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { componentSpan, looksLikeSpec, parseSpecDoc, pathFromMessage, placeIssues } from '../src/lineMap';
import { validateSpec } from '../../src/spec/validate';

const BAD = `version: 1
name: Bad
components:
  - { id: users, kind: client }
  - id: api
    kind: servr
    instances: 0
  - { id: db, kind: db, autoscale: { min: 0 } }
connections:
  - users -> api
  - [api, ghost]
zones:
  - { id: a, members: [api, nope] }
`;

const line = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle));

describe('diagnostics land on the right line', () => {
  it('schema errors, by path', () => {
    const doc = parseSpecDoc(BAD);
    const placed = placeIssues(doc, validateSpec(doc.value).issues);
    const at = (needle: string) => placed.filter((p) => p.message.includes(needle)).map((p) => p.span.line);
    expect(at('kind "servr"')).toEqual([line(BAD, 'kind: servr')]);
    expect(at('instances must be at least 1')).toEqual([line(BAD, 'instances: 0')]);
    expect(at('autoscale.min')).toEqual([line(BAD, 'autoscale')]);
    // the value itself is marked, not the whole line
    const kind = placed.find((p) => p.message.includes('servr'))!.span;
    expect(BAD.split('\n')[kind.line].slice(kind.character, kind.endCharacter)).toBe('servr');
  });

  it('lint, by path', () => {
    const text = BAD.replace('servr', 'server').replace('instances: 0', 'instances: 2').replace('{ min: 0 }', '{ min: 1, max: 2 }');
    const doc = parseSpecDoc(text);
    const placed = placeIssues(doc, validateSpec(doc.value).issues);
    const at = (needle: string) => placed.find((p) => p.message.includes(needle))?.span.line;
    expect(at('unknown component "ghost"')).toBe(line(text, '[api, ghost]'));
    expect(at('unknown member "nope"')).toBe(line(text, 'members: [api, nope]'));
    expect(at('"api" has 2 instances')).toBe(line(text, 'id: api'));
    expect(at('"db" receives no traffic')).toBe(line(text, 'id: db'));
  });

  it('the CLI gives only messages: the same lines from the message', () => {
    const doc = parseSpecDoc(BAD);
    const cli = validateSpec(doc.value).issues.map(({ level, message }) => ({ level, message }));
    const byPath = placeIssues(doc, validateSpec(doc.value).issues).map((p) => p.span.line);
    const byMessage = placeIssues(doc, cli).map((p) => p.span.line);
    expect(byMessage).toEqual(byPath);
  });

  it('messages as the native CLI words them', () => {
    const value = { components: [{ id: 'u', kind: 'client' }, { id: 'api', kind: 'servr' }, { kind: 'db' }], connections: ['u -> api', 'a b c', ['api']], zones: [{ id: 'z', members: ['x'] }] };
    expect(pathFromMessage('component "api": kind "servr" is not valid — did you mean "server"?', value)).toEqual(['components', 1, 'kind']);
    expect(pathFromMessage('component "db": autoscale.max is missing', { components: [{ id: 'db' }] })).toEqual(['components', 0, 'autoscale', 'max']);
    expect(pathFromMessage('component #3: id is missing', value)).toEqual(['components', 2, 'id']);
    expect(pathFromMessage('connection "a b c": write it as "from -> to", ["from", "to"] or { from, to }', value)).toEqual(['connections', 1]);
    expect(pathFromMessage('connection ["api"]: write it as "from -> to", ["from", "to"] or { from, to }', value)).toEqual(['connections', 2]);
    expect(pathFromMessage('zone "z" lists unknown member "x"', value)).toEqual(['zones', 0, 'members', 0]);
    expect(pathFromMessage('lb "api" has nothing behind it — every request fails', value)).toEqual(['components', 1]);
    expect(pathFromMessage('no traffic source: add a component with kind "client"', value)).toEqual(['components']);
  });

  it('YAML syntax errors keep their own position', () => {
    const doc = parseSpecDoc('components:\n  - { id: a, kind: client\nconnections: []\n');
    expect(doc.value).toBeUndefined();
    expect(doc.syntax.length).toBeGreaterThan(0);
    expect(doc.syntax[0].level).toBe('error');
    expect(doc.syntax[0].span.line).toBeGreaterThanOrEqual(1);
  });

  it('a path that runs past the document stops at what exists', () => {
    const doc = parseSpecDoc(BAD);
    expect(doc.locate(['components', 9, 'id']).line).toBe(line(BAD, 'components:'));
    expect(doc.locate(['components', 1, 'autoscale', 'max']).line).toBe(line(BAD, 'id: api'));
  });
});

describe('what counts as a spec', () => {
  it('by name or by shape', () => {
    const shop = parseSpecDoc(readFileSync(new URL('../../examples/shop.yaml', import.meta.url), 'utf8'));
    expect(looksLikeSpec('shop.yaml', shop.value)).toBe(true);
    expect(looksLikeSpec('x.hindcast.yaml', undefined)).toBe(true);
    expect(looksLikeSpec('docker-compose.yml', { services: { a: {} } })).toBe(false);
    expect(looksLikeSpec('k8s.yaml', { kind: 'Deployment', components: 'x' })).toBe(false);
  });

  it('jumps from a board component to its line', () => {
    const doc = parseSpecDoc(BAD);
    expect(componentSpan(doc, 'db')?.line).toBe(line(BAD, 'id: db'));
    expect(componentSpan(doc, 'missing')).toBeNull();
  });
});
