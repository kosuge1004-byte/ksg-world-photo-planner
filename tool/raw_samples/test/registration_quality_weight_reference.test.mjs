import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidRegistrationWeightInput,
  registrationQualityWeight,
} from '../registration_quality_weight_reference.mjs';

test('a perfect fit (rmsResidual=0) gets the maximum weight of 1', () => {
  assert.equal(registrationQualityWeight(0), 1);
});

test(
  'a fit exactly at residualHalfWeightRadius gets exactly half weight',
  () => {
    assert.ok(
      Math.abs(registrationQualityWeight(1.5) - 0.5) < 1e-9,
    );
    assert.ok(
      Math.abs(
        registrationQualityWeight(2.0, { residualHalfWeightRadius: 2.0 })
          - 0.5,
      ) < 1e-9,
    );
  },
);

test('weight decreases monotonically as rmsResidual increases', () => {
  let previous = Infinity;
  for (let residual = 0; residual <= 20; residual += 0.25) {
    const weight = registrationQualityWeight(residual);
    assert.ok(
      weight <= previous,
      `weight increased at residual=${residual}: ${weight} > ${previous}`,
    );
    previous = weight;
  }
});

test(
  'weight never drops below minimumWeight, even for a huge residual',
  () => {
    const weight = registrationQualityWeight(1000, { minimumWeight: 0.05 });
    assert.equal(weight, 0.05);
  },
);

test(
  'a smaller minimumWeight allows the falloff to continue further',
  () => {
    const withFloor = registrationQualityWeight(50, { minimumWeight: 0.05 });
    const withoutFloor = registrationQualityWeight(50, { minimumWeight: 0 });
    assert.ok(withoutFloor < withFloor);
    assert.ok(withoutFloor > 0);
  },
);

test(
  'a larger residualHalfWeightRadius is more forgiving of a given '
  + 'residual',
  () => {
    const strict = registrationQualityWeight(2, {
      residualHalfWeightRadius: 1.5,
    });
    const lenient = registrationQualityWeight(2, {
      residualHalfWeightRadius: 5,
    });
    assert.ok(
      lenient > strict,
      `expected a larger tolerance radius to give a higher weight for `
        + `the same residual: ${lenient} vs ${strict}`,
    );
  },
);

test('weight is always in (0, 1]', () => {
  for (const residual of [0, 0.001, 0.5, 1.5, 3, 10, 1e6]) {
    const weight = registrationQualityWeight(residual);
    assert.ok(
      weight > 0 && weight <= 1,
      `residual=${residual}: weight=${weight}`,
    );
  }
});

test('rejects a negative rmsResidual', () => {
  assert.throws(
    () => registrationQualityWeight(-0.1),
    InvalidRegistrationWeightInput,
  );
});

test('rejects a non-finite rmsResidual', () => {
  assert.throws(
    () => registrationQualityWeight(NaN),
    InvalidRegistrationWeightInput,
  );
  assert.throws(
    () => registrationQualityWeight(Infinity),
    InvalidRegistrationWeightInput,
  );
});

test('rejects a non-positive residualHalfWeightRadius', () => {
  assert.throws(
    () => registrationQualityWeight(1, { residualHalfWeightRadius: 0 }),
    InvalidRegistrationWeightInput,
  );
  assert.throws(
    () => registrationQualityWeight(1, { residualHalfWeightRadius: -1 }),
    InvalidRegistrationWeightInput,
  );
});

test('rejects a minimumWeight outside [0, 1]', () => {
  assert.throws(
    () => registrationQualityWeight(1, { minimumWeight: -0.1 }),
    InvalidRegistrationWeightInput,
  );
  assert.throws(
    () => registrationQualityWeight(1, { minimumWeight: 1.1 }),
    InvalidRegistrationWeightInput,
  );
});


test('registration weighting rejects infinite half-weight radius', () => {
  assert.throws(
    () => registrationQualityWeight(1, {
      residualHalfWeightRadius: Number.POSITIVE_INFINITY,
    }),
    /finite and positive/,
  );
});
