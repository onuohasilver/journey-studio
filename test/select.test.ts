import {describe, expect, it} from 'vitest';
import {selectJourneys} from '../src/core/select';

const journeys = [
  {name: 'Signup', file: 'signup.journey.json', tags: ['smoke', 'auth']},
  {name: 'Checkout', file: 'checkout.journey.json', tags: ['payments']},
  {name: 'Refunds', file: 'refunds.journey.json', tags: []},
];

describe('choosing what to run', () => {
  it('runs everything when nothing is asked for', () => {
    expect(selectJourneys(journeys, {}).wanted).toHaveLength(3);
  });

  it('matches a journey by name or by file', () => {
    expect(selectJourneys(journeys, {names: ['Signup']}).wanted.map((j) => j.name)).toEqual(['Signup']);
    expect(selectJourneys(journeys, {names: ['checkout']}).wanted.map((j) => j.name)).toEqual(['Checkout']);
    expect(selectJourneys(journeys, {names: ['refunds.journey.json']}).wanted.map((j) => j.name)).toEqual(['Refunds']);
  });

  it('matches any of several tags', () => {
    expect(selectJourneys(journeys, {tags: ['smoke', 'payments']}).wanted.map((j) => j.name)).toEqual([
      'Signup',
      'Checkout',
    ]);
  });

  it('narrows rather than widens when both are given', () => {
    // "the checkout journey, if it is a smoke test" — the reading that never
    // surprises anyone. The union reading is what someone eventually wants and
    // is not what they expect from this command.
    expect(selectJourneys(journeys, {names: ['Checkout'], tags: ['smoke']}).wanted).toEqual([]);
    expect(selectJourneys(journeys, {names: ['Signup'], tags: ['smoke']}).wanted.map((j) => j.name)).toEqual([
      'Signup',
    ]);
  });

  it('names the tags that do exist when one does not match', () => {
    // The mistake is nearly always a typo or a tag nobody applied yet.
    const {error} = selectJourneys(journeys, {tags: ['smoek']});
    expect(error).toContain('No journey is tagged smoek');
    expect(error).toContain('smoke, auth, payments');
  });

  it('says so when no journey carries any tag at all', () => {
    const untagged = [{name: 'A', file: 'a.journey.json', tags: []}];
    expect(selectJourneys(untagged, {tags: ['smoke']}).error).toContain('No journey carries any tag yet');
  });

  it('lists what is available when a name is wrong', () => {
    const {error} = selectJourneys(journeys, {names: ['Signupp']});
    expect(error).toContain('No saved journey matched: Signupp');
    expect(error).toContain('Signup, Checkout, Refunds');
  });

  it('has its own message for an empty suite', () => {
    expect(selectJourneys([], {}).error).toContain('Save one from the studio first');
  });
});
