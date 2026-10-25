import { z } from 'zod'

export const COLOR_NORMALIZATION_PROFILE_ID = 'color-normalization-hsv12-v1' as const
export const COLOR_NORMALIZATION_SOURCE_COMMIT = '167e6e2c50465e79649a4d1dca59cbf6b878c071' as const
export const COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256 =
  '0f2fef5754e83e7d3999a0f3a725c059f746519b222c2b3005fcd47806480b1f' as const
export const COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256 =
  'd72afa66096ea353d43f50fa01acbf03bf6875278ab4ea235051a0a6d5025009' as const
export const COLOR_NORMALIZATION_EVALUATOR_TRUTH_SHA256 =
  'af5bf46d19c7c7dd418f6da0b2d26b7708bf7e4ca659ea378641c424e2f3a1dd' as const

export const COLOR_NORMALIZATION_MAX_PIXELS = 2_097_152 as const
export const COLOR_NORMALIZATION_MAX_ENCODED_BYTES = 32 * 1024 * 1024
export const COLOR_NORMALIZATION_RUN_DEADLINE_MS = 120_000 as const
export const COLOR_NORMALIZATION_RUN_SCHEMA = 'v03-color-normalization-run-v1' as const
export const COLOR_NORMALIZATION_EVALUATION_SCHEMA =
  'v03-color-normalization-evaluation-v1' as const

export const COLOR_NORMALIZATION_BOX_IOU_GATE = 0.5 as const
export const COLOR_NORMALIZATION_BOX_COVERAGE_GATE = 0.9 as const
export const COLOR_NORMALIZATION_MASK_IOU_GATE = 0.8 as const

export const COLOR_NORMALIZATION_HUE_BINS = 12 as const
export const COLOR_NORMALIZATION_BLACK_VALUE_BELOW = 0.15 as const
export const COLOR_NORMALIZATION_ACHROMATIC_SATURATION_BELOW = 0.2 as const
export const COLOR_NORMALIZATION_ACHROMATIC_WHITE_VALUE_AT_LEAST = 0.75 as const

export const COLOR_NORMALIZATION_MONTAGE_CASE_IDS = [
  'pilot-v03-photo-01',
  'pilot-v03-ui-01',
  'pilot-v03-map-01',
] as const

export const COLOR_NORMALIZATION_EVALUATOR_LABEL_RU =
  'выбрано оценщиком; не автоматическое распознавание' as const
export const COLOR_NORMALIZATION_EVALUATOR_LABEL_EN =
  'evaluator-selected; not automatic detection' as const

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)

const colorNormalizationImageRefSchema = z
  .object({
    path: z.string().min(1),
    sha256: digestSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()

const colorNormalizationProducerRowSchema = z
  .object({
    caseId: z.string().min(1),
    image: colorNormalizationImageRefSchema,
  })
  .strict()

export const colorNormalizationProducerInputsSchema = z
  .array(colorNormalizationProducerRowSchema)
  .length(12)

type ColorNormalizationProducerRow = z.infer<typeof colorNormalizationProducerRowSchema>

/** Frozen 12-row producer cohort; producer validates inputs match this exactly. */
export const COLOR_NORMALIZATION_FROZEN_PRODUCER_ROWS: readonly ColorNormalizationProducerRow[] = [
  {
    caseId: 'pilot-v03-photo-01',
    image: {
      path: 'benchmarks/cache/v02/corpus/photos/e4cb43222c9bee50.jpg',
      sha256: '71b99532e14abb6098a704e9bd9c2c50eebba72588a49e60c8a4b89af4eea4c5',
      width: 1024,
      height: 683,
    },
  },
  {
    caseId: 'pilot-v03-photo-02',
    image: {
      path: 'benchmarks/cache/v02/corpus/photos/4f05ad23beaefd46.jpg',
      sha256: 'ad0eb4bf4a6c2c1be585846a943aa06ec2440696b7e8874374904eb25dcc594a',
      width: 1024,
      height: 683,
    },
  },
  {
    caseId: 'pilot-v03-photo-03',
    image: {
      path: 'benchmarks/cache/v02/corpus/photos/b0a59eeab8c5166c.jpg',
      sha256: '4a0dffd0f9f85bacac77d4f372c1f3eb754ba6a7440de3bc7c7f6a42f4c53ecd',
      width: 1024,
      height: 768,
    },
  },
  {
    caseId: 'pilot-v03-photo-04',
    image: {
      path: 'benchmarks/cache/v02/corpus/photos/398a3ffc8a7e36a8.jpg',
      sha256: '085ac7dc3243e28816e69f5e1ad56b9e8858c7135fac366f3172ad862e28eeae',
      width: 1024,
      height: 683,
    },
  },
  {
    caseId: 'pilot-v03-ui-01',
    image: {
      path: 'benchmarks/cache/v02/corpus/independent-ui/geany-dev-oracle-20261020-run02.png',
      sha256: '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09',
      width: 1280,
      height: 800,
    },
  },
  {
    caseId: 'pilot-v03-ui-02',
    image: {
      path: 'benchmarks/cache/v02/corpus/independent-ui/geany-dev-oracle-20261020-run02.png',
      sha256: '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09',
      width: 1280,
      height: 800,
    },
  },
  {
    caseId: 'pilot-v03-ui-03',
    image: {
      path: 'benchmarks/cache/v02/corpus/independent-ui/geany-dev-oracle-20261020-run02.png',
      sha256: '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09',
      width: 1280,
      height: 800,
    },
  },
  {
    caseId: 'pilot-v03-ui-04',
    image: {
      path: 'benchmarks/cache/v02/corpus/independent-ui/geany-dev-oracle-20261020-run02.png',
      sha256: '0f9fc1eee9473f8ecf03a61e9dc7fccf369e1bc58feb9d0671165b16eded1a09',
      width: 1280,
      height: 800,
    },
  },
  {
    caseId: 'pilot-v03-map-01',
    image: {
      path: 'benchmarks/cache/v02/corpus/independent-map/freeciv-dev-explorer-a6-24-20261020.png',
      sha256: '07e1ea0a28ea9e7e183e6c8c04797e0fee0995c9f91d0933293bac73f2ea4e2a',
      width: 1280,
      height: 800,
    },
  },
  {
    caseId: 'pilot-v03-map-02',
    image: {
      path: 'benchmarks/cache/v02/corpus/independent-map/freeciv-dev-explorer-a6-23-20261020.png',
      sha256: 'a970216cbccf7456464e5ca25fc120e1e3994344e5fdc95607c1eb27d61ec205',
      width: 1280,
      height: 800,
    },
  },
  {
    caseId: 'pilot-v03-map-03',
    image: {
      path: 'benchmarks/cache/v02/corpus/independent-map/freeciv-dev-explorer-a6-16-20261020.png',
      sha256: '1d696fe4fd5ab990650da67c20b78d3240c048e4849ab8f043c398cfcf1ecc85',
      width: 1280,
      height: 800,
    },
  },
  {
    caseId: 'pilot-v03-map-04',
    image: {
      path: 'benchmarks/cache/v02/corpus/independent-map/freeciv-dev-inventory-a6-29-20261020.png',
      sha256: '4c48235b5a5c4413eccae22ad9ef2e89b697c073d40cf8c7b3c8978b662eacfa',
      width: 1280,
      height: 800,
    },
  },
] as const

const colorNormalizationImageStatsSchema = z
  .object({
    distinctCanonicalColors: z.number().int().nonnegative(),
    componentCount: z.number().int().nonnegative(),
    adjacentDifferingColorEdges: z.number().int().nonnegative(),
    changedAdjacentEdgesVsSourceRgb: z.number().int().nonnegative(),
    sourcePixels: z.number().int().nonnegative(),
    elapsedMs: z.number().finite().nonnegative(),
  })
  .strict()

export const colorNormalizationRunManifestSchema = z
  .object({
    schema: z.literal(COLOR_NORMALIZATION_RUN_SCHEMA),
    status: z.enum(['complete', 'failed', 'incomplete']),
    profileId: z.literal(COLOR_NORMALIZATION_PROFILE_ID),
    prospectiveFreezeSha256: z.literal(COLOR_NORMALIZATION_PROSPECTIVE_FREEZE_SHA256),
    sourceCommit: z.literal(COLOR_NORMALIZATION_SOURCE_COMMIT),
    producerInputsSha256: z.literal(COLOR_NORMALIZATION_PRODUCER_INPUTS_SHA256),
    producerCodeSha256: digestSchema,
    dataRoot: z.string().min(1),
    deadlineMs: z.literal(COLOR_NORMALIZATION_RUN_DEADLINE_MS),
    rows: z.array(
      z
        .object({
          caseId: z.string().min(1),
          imageSha256: digestSchema,
          imagePath: z.string().min(1),
          sourceWidth: z.number().int().positive(),
          sourceHeight: z.number().int().positive(),
          uniqueImageKey: digestSchema,
          artifacts: z
            .object({
              normalizedHsv12Png: z.string().min(1),
              normalizedHsv12Sha256: digestSchema,
              componentMapRgb: z.string().min(1),
              componentMapRgbSha256: digestSchema,
              componentMapHsv12: z.string().min(1),
              componentMapHsv12Sha256: digestSchema,
            })
            .strict(),
          profiles: z
            .object({
              controlRgb: colorNormalizationImageStatsSchema,
              hsv12: colorNormalizationImageStatsSchema,
            })
            .strict(),
        })
        .strict(),
    ),
    uniqueImages: z.array(
      z
        .object({
          key: digestSchema,
          sha256: digestSchema,
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          path: z.string().min(1),
        })
        .strict(),
    ),
    failure: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        caseId: z.string().optional(),
        imageSha256: digestSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type ColorNormalizationRunManifest = z.infer<typeof colorNormalizationRunManifestSchema>
