import {describe, expect, it} from 'vitest';
import {importOpenApi} from '../src/core/openapi';

const PETSTORE = `
openapi: 3.0.0
info: {title: Petstore, version: "1.2"}
servers: [{url: "https://api.example.com/v1"}]
paths:
  /pets:
    get:
      operationId: listPets
      tags: [pets]
      summary: List pets
      parameters:
        - {name: limit, in: query, schema: {type: integer, default: 20}}
        - {name: status, in: query, required: true, schema: {type: string, enum: [available, sold]}}
      responses:
        "200": {content: {application/json: {schema: {type: array}}}}
    post:
      operationId: createPet
      tags: [pets]
      summary: Add a pet
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                name: {type: string, example: Rex}
                age: {type: integer}
      responses:
        "201":
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: {type: string}
                  name: {type: string}
  /pets/{petId}:
    get:
      operationId: getPet
      tags: [pets]
      parameters:
        - {name: petId, in: path, required: true, schema: {type: string}}
      responses:
        "200": {content: {application/json: {schema: {$ref: "#/components/schemas/Pet"}}}}
    delete:
      operationId: deletePet
      tags: [pets]
      parameters:
        - {name: petId, in: path, required: true, schema: {type: string}}
      responses:
        "204": {description: gone}
components:
  schemas:
    Pet:
      type: object
      properties:
        id: {type: string}
        name: {type: string}
`;

const imported = importOpenApi(PETSTORE, 'petstore.yaml');
const byId = (suffix: string) => imported.nodes.find((n) => n.type.endsWith(suffix))!;

describe('importing an OpenAPI document', () => {
  it('reads the document and namespaces every operation', () => {
    expect(imported.ok).toBe(true);
    expect(imported.title).toBe('Petstore');
    expect(imported.servers).toEqual(['https://api.example.com/v1']);
    expect(imported.nodes).toHaveLength(4);
    // Namespaced so two specs can be loaded at once without shadowing.
    expect(imported.nodes.every((n) => n.type.startsWith('openapi.petstore.'))).toBe(true);
  });

  it('turns path parameters into fields that chain by default', () => {
    // The single most important choice in the importer: a path param defaults to
    // the matching context var, so `/pets/{petId}` picks up whatever created it.
    const get = byId('getPet');
    expect(get.request!.path).toBe('/pets/{{fields.petId}}');
    expect(get.defaults!.petId).toBe('{{vars.petId}}');
    expect(get.needs).toEqual(['petId']);
  });

  it('infers what a create hands forward, named after the resource', () => {
    expect(byId('createPet').gives).toEqual([{key: 'petId', from: 'body.id'}]);
  });

  it('infers nothing when the response has no id to take', () => {
    expect(byId('listPets').gives).toEqual([]);
  });

  it('keeps the body as one editable JSON field, seeded from the spec', () => {
    const post = byId('createPet');
    expect(post.request!.body).toBe('{{fields.body}}');
    expect(post.defaults!.body).toEqual({name: 'Rex', age: 0});
    expect(post.fields.find((f) => f.key === 'body')!.kind).toBe('json');
  });

  it('carries query parameters, with enums as a select', () => {
    const list = byId('listPets');
    expect(list.request!.query).toEqual({limit: '{{fields.limit}}', status: '{{fields.status}}'});
    expect(list.defaults!.limit).toBe('');            // optional — omitted unless filled
    expect(list.defaults!.status).toBe('available');  // required — seeded
    expect(list.fields.find((f) => f.key === 'status')!.options).toEqual([
      {value: 'available', label: 'available'},
      {value: 'sold', label: 'sold'},
    ]);
  });

  it('resolves local $refs', () => {
    expect(byId('getPet').gives).toEqual([{key: 'petId', from: 'body.id'}]);
  });

  it('asserts the status the spec documents', () => {
    expect(byId('createPet').assertions).toEqual([{op: 'status', expected: 201}]);
    expect(byId('deletePet').assertions).toEqual([{op: 'status', expected: 204}]);
  });

  it('marks deletes as destructive', () => {
    expect(byId('deletePet').destructive).toBe(true);
    expect(byId('getPet').destructive).toBe(false);
  });

  it('accepts JSON as well as YAML', () => {
    const json = importOpenApi(
      JSON.stringify({openapi: '3.0.0', info: {title: 'J'}, paths: {'/a': {get: {responses: {}}}}}),
    );
    expect(json.ok).toBe(true);
    expect(json.nodes).toHaveLength(1);
  });
});

describe('rejecting documents it cannot use', () => {
  it('explains a parse failure instead of throwing', () => {
    const r = importOpenApi('{ not json');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Could not parse');
  });

  it('says so when the file is not an API document', () => {
    expect(importOpenApi('name: my-app\nversion: 1').error).toContain('is this an API document');
  });

  it('names Swagger 2.0 rather than failing obscurely', () => {
    expect(importOpenApi('swagger: "2.0"\ninfo: {title: Old}').error).toContain('Swagger 2.0');
  });

  it('reports a document with no operations', () => {
    expect(importOpenApi('openapi: 3.0.0\ninfo: {title: Empty}\npaths: {}').error).toContain('no operations');
  });

  it('renames a duplicate operationId instead of dropping the operation', () => {
    const r = importOpenApi(`
openapi: 3.0.0
info: {title: Dup}
paths:
  /a: {get: {operationId: same, responses: {}}}
  /b: {get: {operationId: same, responses: {}}}
`);
    expect(r.nodes).toHaveLength(2);
    expect(r.warnings.join(' ')).toContain('Duplicate operationId');
  });
});
