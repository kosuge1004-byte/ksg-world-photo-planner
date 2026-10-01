/// Reference implementation of reconstructing a single, native-CFA-
/// resolution raw mosaic from CFA-domain drizzle output
/// (`cfa_drizzle_reference.mjs`, Work85/87), bridging CFA drizzle to
/// this project's real adaptive demosaic engine
/// (`mobile_stack_adaptive_demosaic_engine.dart`) for the first time.
///
/// Until this module, this project's CFA drizzle pipeline finished with
/// `drizzle_gap_fill_reference.mjs` (Work91) — a same-channel-only
/// local average, deliberately *not* a real demosaic (it never looks at
/// a different color channel's data, by design, to avoid mixing
/// channels inappropriately before the real reconstruction step). That
/// left the pipeline's own most consequential quality step — turning
/// three sparse, independent color planes into one coherent, edge-aware
/// RGB image — undone by anything more sophisticated than a local
/// average, even though this project has a real, structure-tensor-based
/// adaptive demosaic engine sitting unused downstream of it.
///
/// The obstacle: the real demosaic engine's own input contract is a
/// *regular* Bayer mosaic (`LinearRawMosaic`, with a fixed `CfaPattern`
/// — exactly one known channel per pixel, following one of four
/// standard repeating 2x2 patterns). CFA drizzle's own output is not
/// that: coverage is spread irregularly across all three channels at
/// every position, shaped by however many frames' sub-pixel-registered
/// samples happened to land nearby, not a clean repeating pattern.
///
/// This module bridges the two, **for `outputScale = 1` (no
/// supersampling) specifically**: at native resolution, the drizzle
/// output grid is pixel-aligned with the reference frame's own raw
/// mosaic, so every output position (x, y) has a well-defined "native
/// phase" — the same channel [referenceCfaPattern] would assign to that
/// exact position in an ordinary, undrizzled raw frame. Reading *only*
/// that one channel's drizzled value at each position — discarding the
/// other two channels' own accumulated data there — produces a
/// [LinearRawMosaic] indistinguishable in *shape* from a single ordinary
/// camera exposure, except that each sample is now a noise-reduced,
/// sub-pixel-registered combination of every input frame's own
/// contribution at that position (including, at minimum, the reference
/// frame's own untransformed sample there, which alone already
/// guarantees at least some coverage for the correct-phase channel at
/// every position). The result can be handed to the existing demosaic
/// engine completely unmodified.
///
/// This *does* leave some of drizzle's own accumulated data unused (the
/// coverage that happened to land on the two channels *not* native to a
/// given position, at that exact position) — an intentional, disclosed
/// trade-off for `outputScale = 1`, not a defect: true super-resolution
/// output (`outputScale > 1`) does not have a well-defined "native
/// phase" at every position (each native CFA cell maps to multiple
/// output positions), and reconciling that with the existing demosaic
/// engine's own regular-pattern assumption is a separate, larger
/// architectural question this module does not attempt to solve —
/// [reconstructNativeCfaMosaicFromDrizzle] validates its own
/// [outputScale] parameter is exactly `1` and throws otherwise, rather
/// than silently producing a wrong result for the supersampled case.
///
/// A position whose native-phase channel happens to have zero coverage
/// (theoretically possible if, unusually, not even the reference frame
/// contributed there — e.g. a masked/invalid region) is filled from
/// that *same channel's* nearby same-phase neighbors via
/// `drizzle_gap_fill_reference.mjs`'s own `fillChannelGaps`, not
/// silently left at a meaningless `0` — this module does not change
/// that established gap-filling contract, only narrows which channel's
/// gaps matter to just the one each position actually needs.

export class InvalidCfaReconstructionInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCfaReconstructionInput';
  }
}

const CFA_COLOR_INDEX = {
  red: 0, green: 1, blue: 2,
};

function cfaColorIndexAt(pattern, x, y) {
  const evenX = (x % 2) === 0;
  const evenY = (y % 2) === 0;
  switch (pattern) {
    case 'rggb':
      if (evenX && evenY) return CFA_COLOR_INDEX.red;
      if (!evenX && !evenY) return CFA_COLOR_INDEX.blue;
      return CFA_COLOR_INDEX.green;
    case 'bggr':
      if (evenX && evenY) return CFA_COLOR_INDEX.blue;
      if (!evenX && !evenY) return CFA_COLOR_INDEX.red;
      return CFA_COLOR_INDEX.green;
    case 'grbg':
      if (!evenX && evenY) return CFA_COLOR_INDEX.red;
      if (evenX && !evenY) return CFA_COLOR_INDEX.blue;
      return CFA_COLOR_INDEX.green;
    case 'gbrg':
      if (evenX && !evenY) return CFA_COLOR_INDEX.red;
      if (!evenX && evenY) return CFA_COLOR_INDEX.blue;
      return CFA_COLOR_INDEX.green;
    default:
      throw new InvalidCfaReconstructionInput(
        `Unsupported CFA pattern: ${pattern}`,
      );
  }
}

/// Reconstructs a single, native-resolution [LinearRawMosaic]-shaped
/// object (`{width, height, cfaPattern, samples}`) from [drizzleResult]
/// (a `cfaDrizzle`-shaped `{width, height, channels}`, `channels` an
/// array of three `{value, coverage}` pairs — see this module's own doc
/// comment for the full design).
///
/// - [referenceCfaPattern]: which of the four standard Bayer patterns
///   defines each position's "native phase" — must match the reference
///   frame's own actual CFA pattern (the frame [drizzleResult]'s own
///   coordinate grid is aligned to).
/// - [outputScale]: must be exactly `1` — see this module's own doc
///   comment for why supersampled output is out of scope here.
/// - [fillChannelGapsFn]: the gap-filling function to use per channel
///   (dependency-injected so this reference implementation does not
///   need to import `drizzle_gap_fill_reference.mjs` directly, keeping
///   the two modules' own test suites independent).
/// - [gapFillOptions]: forwarded to [fillChannelGapsFn].
///
/// Throws {@link InvalidCfaReconstructionInput} if [outputScale] is not
/// `1`, or [drizzleResult] does not have exactly three channels.
export function reconstructNativeCfaMosaicFromDrizzle(
  drizzleResult,
  referenceCfaPattern,
  outputScale,
  fillChannelGapsFn,
  gapFillOptions = {},
) {
  if (outputScale !== 1) {
    throw new InvalidCfaReconstructionInput(
      'reconstructNativeCfaMosaicFromDrizzle only supports outputScale = 1 '
      + '(supersampled output has no well-defined native CFA phase at '
      + `every position); got ${outputScale}.`,
    );
  }
  const { width, height, channels } = drizzleResult;
  if (!Array.isArray(channels) || channels.length !== 3) {
    throw new InvalidCfaReconstructionInput(
      'drizzleResult must have exactly 3 channels.',
    );
  }

  // 各チャンネルを、そのチャンネル自身の近傍だけでギャップ埋めして
  // おく(fillChannelGaps自身の「他チャンネルとは混ぜない」という
  // 既存の契約をそのまま踏襲する)。
  const filledChannels = channels.map(
    (channel) => fillChannelGapsFn(channel, width, height, gapFillOptions),
  );

  const samples = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const channelIndex = cfaColorIndexAt(referenceCfaPattern, x, y);
      samples[index] = filledChannels[channelIndex].value[index];
    }
  }

  return {
    width, height, cfaPattern: referenceCfaPattern, samples,
  };
}
