/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 * Produced by scripts/odds-calibration-study.py --stage holdout (DECISION-CALL-V2-W4 CH1).
 * tests/unit/pre-trade-odds-calibration.test.ts seals this file's sha256 against
 * tests/fixtures/odds-calibration/generated.sha256; a hand edit fails that test (AC1.3).
 * Re-running the committed script on the same archives reproduces these bytes (AC1.2).
 *
 * INTERNAL ONLY. The no-edge odds are computed and logged by CH2, never served (spec §0).
 * Pre-registration (every definition, fixed before any data read): vault
 * audits/DECISION-CALL-V2-W4-preregistration.md, sha256 1a203e1f797c667f7603706c58fb236c8d02494ed6fb00b855ed873585a38c48.
 * Fit window and hold-out window, scored once, are recorded in `provenance`.
 */

export const ODDS_VERSION = 'odds-v1' as const;

export type OddsField = 'timeout' | 'target_first' | 'liquidation';
export type OddsVerdict = 'calibrated' | 'uncalibrated' | 'indeterminate';
export type OddsRecalInput = 'p_bm' | 'd_over_sigma_h';
export type OddsStage = 'dryrun' | 'holdout';

/** One of 20 equal-count recalibration bins fitted on the fit window (B9): lo ≤ v < hi; a null edge is ±∞.
 *  `value` is the fit-window mean label of the bin (null when no fit row fell in it — unreachable by construction). */
export interface OddsRecalBin {
  readonly lo: number | null;
  readonly hi: number | null;
  readonly value: number | null;
  readonly nFit: number;
}

/** One of 10 equal-count reliability bins over the pooled hold-out (B11). gapPp = (pMean − yMean)·100, 3 dp half-up. */
export interface OddsReliabilityBin {
  readonly n: number;
  readonly pMean: number;
  readonly yMean: number;
  readonly gapPp: number;
}

/** Hold-out scores of one cell (B11/B12). brierRecal3 / brierClim3 are the 3-dp half-up comparison values;
 *  recalLeClim is brierRecal3 ≤ brierClim3, derived once in Python. maxNonOverlappingHolds bounds the
 *  independent-hold count per coin behind `n` (rows are overlapping holds of one path). */
export interface OddsCellScore {
  readonly cellId: string;
  readonly holdH: number;
  readonly stopPct: number | null;
  readonly targetPct: number | null;
  readonly stopSigma: number | null;
  readonly targetSigma: number | null;
  readonly leverage: number | null;
  readonly n: number;
  readonly nDoubleTouch: number;
  readonly nHoldGap: number;
  readonly maxNonOverlappingHolds: number;
  readonly baseRateFit: number;
  readonly yMeanHoldout: number;
  readonly pBmMeanHoldout: number;
  readonly pRecalMeanHoldout: number;
  readonly brierBm: number;
  readonly brierRecal: number;
  readonly brierClim: number;
  readonly brierRecal3: number;
  readonly brierClim3: number;
  readonly recalLeClim: boolean;
}

export interface OddsFieldCalibration {
  readonly pass: boolean;
  readonly verdict: OddsVerdict;
  readonly verdictDetail: string;
  readonly recalInput: OddsRecalInput;
  readonly nFitRows: number;
  readonly nHoldoutRows: number;
  readonly ecePp: number;
  readonly ecePpBm: number;
  readonly recalBins: readonly OddsRecalBin[];
  readonly reliability: readonly OddsReliabilityBin[];
  readonly reliabilityBm: readonly OddsReliabilityBin[];
  readonly cells: readonly OddsCellScore[];
}

export interface OddsWindow {
  readonly start: string;
  readonly end: string;
}

export interface OddsArchiveChecksum {
  readonly file: string;
  readonly sha256: string;
}

export interface OddsProvenance {
  readonly version: typeof ODDS_VERSION;
  readonly stage: OddsStage;
  readonly preregistrationSha256: string;
  readonly archiveManifestSha256: string;
  readonly archiveCount: number;
  readonly archiveChecksums: readonly OddsArchiveChecksum[];
  readonly dataRange: OddsWindow;
  readonly fitWindow: OddsWindow;
  readonly holdoutWindow: OddsWindow;
  readonly coins: readonly string[];
  readonly maintenanceRates: Readonly<Record<string, number>>;
  readonly seed: number;
  readonly entriesPerCoinPerCell: number;
  readonly sigmaBars1h: number;
  readonly atrPeriod: number;
  readonly recalBins: number;
  readonly reliabilityBins: number;
  readonly passRule: string;
}

export interface OddsCalibration {
  readonly fields: {
    readonly timeout: OddsFieldCalibration;
    readonly target_first: OddsFieldCalibration;
    readonly liquidation: OddsFieldCalibration;
  };
  readonly provenance: OddsProvenance;
}

export const ODDS_CALIBRATION: OddsCalibration = {
  fields: {
    timeout: {
      pass: false,
      verdict: 'uncalibrated',
      verdictDetail: 'recalibrated Brier above climatology in: b:0.5/0.75:h24, b:1/2:h72, b:1s/2s:h0.5, b:1s/2s:h4, b:1s/2s:h8, b:1s/2s:h24, b:1s/2s:h72',
      recalInput: 'p_bm',
      nFitRows: 999912,
      nHoldoutRows: 999983,
      ecePp: 0.567,
      ecePpBm: 2.918,
      recalBins: [
        { lo: null, hi: 0.000000, value: 0.000000, nFit: 49996 },
        { lo: 0.000000, hi: 0.000000, value: 0.000040, nFit: 49996 },
        { lo: 0.000000, hi: 0.000006, value: 0.000920, nFit: 49995 },
        { lo: 0.000006, hi: 0.001397, value: 0.011561, nFit: 49996 },
        { lo: 0.001397, hi: 0.023902, value: 0.048325, nFit: 49995 },
        { lo: 0.023902, hi: 0.108630, value: 0.124610, nFit: 49996 },
        { lo: 0.108630, hi: 0.263220, value: 0.244364, nFit: 49995 },
        { lo: 0.263220, hi: 0.446271, value: 0.376310, nFit: 49996 },
        { lo: 0.446271, hi: 0.621768, value: 0.525673, nFit: 49995 },
        { lo: 0.621768, hi: 0.636608, value: 0.610749, nFit: 49996 },
        { lo: 0.636608, hi: 0.637163, value: 0.623130, nFit: 49996 },
        { lo: 0.637163, hi: 0.637726, value: 0.622942, nFit: 49995 },
        { lo: 0.637726, hi: 0.639474, value: 0.584327, nFit: 49996 },
        { lo: 0.639474, hi: 0.768386, value: 0.667807, nFit: 49995 },
        { lo: 0.768386, hi: 0.880679, value: 0.770962, nFit: 49996 },
        { lo: 0.880679, hi: 0.957125, value: 0.864386, nFit: 49995 },
        { lo: 0.957125, hi: 0.993256, value: 0.927354, nFit: 49996 },
        { lo: 0.993256, hi: 0.999906, value: 0.971317, nFit: 49995 },
        { lo: 0.999906, hi: 1.000000, value: 0.992619, nFit: 49996 },
        { lo: 1.000000, hi: null, value: 0.999140, nFit: 49996 },
      ],
      reliability: [
        { n: 99999, pMean: 0.000337, yMean: 0.000800, gapPp: -0.046 },
        { n: 99999, pMean: 0.031672, yMean: 0.035990, gapPp: -0.432 },
        { n: 99999, pMean: 0.209197, yMean: 0.215872, gapPp: -0.667 },
        { n: 99998, pMean: 0.479483, yMean: 0.482040, gapPp: -0.256 },
        { n: 99998, pMean: 0.607271, yMean: 0.619702, gapPp: -1.243 },
        { n: 99998, pMean: 0.627693, yMean: 0.606832, gapPp: 2.086 },
        { n: 99998, pMean: 0.742087, yMean: 0.741795, gapPp: 0.029 },
        { n: 99998, pMean: 0.898502, yMean: 0.897698, gapPp: 0.080 },
        { n: 99998, pMean: 0.977070, yMean: 0.970349, gapPp: 0.672 },
        { n: 99998, pMean: 0.997294, yMean: 0.995690, gapPp: 0.160 },
      ],
      reliabilityBm: [
        { n: 99999, pMean: 0.000000, yMean: 0.000650, gapPp: -0.065 },
        { n: 99999, pMean: 0.005219, yMean: 0.032460, gapPp: -2.724 },
        { n: 99999, pMean: 0.143915, yMean: 0.207412, gapPp: -6.350 },
        { n: 99998, pMean: 0.491476, yMean: 0.497290, gapPp: -0.581 },
        { n: 99998, pMean: 0.636832, yMean: 0.618262, gapPp: 1.857 },
        { n: 99998, pMean: 0.639231, yMean: 0.599432, gapPp: 3.980 },
        { n: 99998, pMean: 0.793447, yMean: 0.741575, gapPp: 5.187 },
        { n: 99998, pMean: 0.955569, yMean: 0.897838, gapPp: 5.773 },
        { n: 99998, pMean: 0.998482, yMean: 0.974519, gapPp: 2.396 },
        { n: 99998, pMean: 1.000000, yMean: 0.997330, gapPp: 0.267 },
      ],
      cells: [
        {
          cellId: 'b:0.5/0.75:h0.5', holdH: 0.5, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39999, nDoubleTouch: 1, nHoldGap: 2, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.575977, yMeanHoldout: 0.715168, pBmMeanHoldout: 0.695067, pRecalMeanHoldout: 0.669070,
          brierBm: 0.1684, brierRecal: 0.1672, brierClim: 0.2231, brierRecal3: 0.167, brierClim3: 0.223, recalLeClim: true,
        },
        {
          cellId: 'b:0.5/0.75:h4', holdH: 4, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39996, nDoubleTouch: 4, nHoldGap: 24, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.100220, yMeanHoldout: 0.176993, pBmMeanHoldout: 0.130523, pRecalMeanHoldout: 0.164927,
          brierBm: 0.1217, brierRecal: 0.1183, brierClim: 0.1516, brierRecal3: 0.118, brierClim3: 0.152, recalLeClim: true,
        },
        {
          cellId: 'b:0.5/0.75:h8', holdH: 8, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39998, nDoubleTouch: 2, nHoldGap: 59, maxNonOverlappingHolds: 912,
          baseRateFit: 0.035087, yMeanHoldout: 0.067378, pBmMeanHoldout: 0.045885, pRecalMeanHoldout: 0.073082,
          brierBm: 0.0555, brierRecal: 0.0549, brierClim: 0.0639, brierRecal3: 0.055, brierClim3: 0.064, recalLeClim: true,
        },
        {
          cellId: 'b:0.5/0.75:h24', holdH: 24, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39997, nDoubleTouch: 3, nHoldGap: 125, maxNonOverlappingHolds: 304,
          baseRateFit: 0.003051, yMeanHoldout: 0.006075, pBmMeanHoldout: 0.004888, pRecalMeanHoldout: 0.012761,
          brierBm: 0.0062, brierRecal: 0.0066, brierClim: 0.0060, brierRecal3: 0.007, brierClim3: 0.006, recalLeClim: false,
        },
        {
          cellId: 'b:0.5/0.75:h72', holdH: 72, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39997, nDoubleTouch: 3, nHoldGap: 406, maxNonOverlappingHolds: 101,
          baseRateFit: 0.000000, yMeanHoldout: 0.000000, pBmMeanHoldout: 0.000316, pRecalMeanHoldout: 0.001325,
          brierBm: 0.0000, brierRecal: 0.0001, brierClim: 0.0000, brierRecal3: 0.000, brierClim3: 0.000, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h0.5', holdH: 0.5, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 2, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.877266, yMeanHoldout: 0.935850, pBmMeanHoldout: 0.951573, pRecalMeanHoldout: 0.914478,
          brierBm: 0.0552, brierRecal: 0.0558, brierClim: 0.0635, brierRecal3: 0.056, brierClim3: 0.063, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h4', holdH: 4, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 39999, nDoubleTouch: 1, nHoldGap: 15, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.428004, yMeanHoldout: 0.579814, pBmMeanHoldout: 0.559898, pRecalMeanHoldout: 0.550281,
          brierBm: 0.2046, brierRecal: 0.2021, brierClim: 0.2667, brierRecal3: 0.202, brierClim3: 0.267, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h8', holdH: 8, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 44, maxNonOverlappingHolds: 912,
          baseRateFit: 0.246937, yMeanHoldout: 0.370050, pBmMeanHoldout: 0.356125, pRecalMeanHoldout: 0.374132,
          brierBm: 0.1936, brierRecal: 0.1899, brierClim: 0.2483, brierRecal3: 0.190, brierClim3: 0.248, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h24', holdH: 24, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 39999, nDoubleTouch: 1, nHoldGap: 123, maxNonOverlappingHolds: 304,
          baseRateFit: 0.060878, yMeanHoldout: 0.109428, pBmMeanHoldout: 0.113928, pRecalMeanHoldout: 0.150167,
          brierBm: 0.0919, brierRecal: 0.0921, brierClim: 0.0998, brierRecal3: 0.092, brierClim3: 0.100, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h72', holdH: 72, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 400, maxNonOverlappingHolds: 101,
          baseRateFit: 0.003025, yMeanHoldout: 0.007025, pBmMeanHoldout: 0.018491, pRecalMeanHoldout: 0.036754,
          brierBm: 0.0100, brierRecal: 0.0119, brierClim: 0.0070, brierRecal3: 0.012, brierClim3: 0.007, recalLeClim: false,
        },
        {
          cellId: 'b:2.5/5:h0.5', holdH: 0.5, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 4, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.986725, yMeanHoldout: 0.995025, pBmMeanHoldout: 0.998754, pRecalMeanHoldout: 0.991075,
          brierBm: 0.0049, brierRecal: 0.0049, brierClim: 0.0050, brierRecal3: 0.005, brierClim3: 0.005, recalLeClim: true,
        },
        {
          cellId: 'b:2.5/5:h4', holdH: 4, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 20, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.831950, yMeanHoldout: 0.910925, pBmMeanHoldout: 0.930154, pRecalMeanHoldout: 0.889874,
          brierBm: 0.0739, brierRecal: 0.0741, brierClim: 0.0874, brierRecal3: 0.074, brierClim3: 0.087, recalLeClim: true,
        },
        {
          cellId: 'b:2.5/5:h8', holdH: 8, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 44, maxNonOverlappingHolds: 912,
          baseRateFit: 0.692975, yMeanHoldout: 0.816650, pBmMeanHoldout: 0.834795, pRecalMeanHoldout: 0.793017,
          brierBm: 0.1330, brierRecal: 0.1325, brierClim: 0.1650, brierRecal3: 0.132, brierClim3: 0.165, recalLeClim: true,
        },
        {
          cellId: 'b:2.5/5:h24', holdH: 24, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 129, maxNonOverlappingHolds: 304,
          baseRateFit: 0.384000, yMeanHoldout: 0.540475, pBmMeanHoldout: 0.569486, pRecalMeanHoldout: 0.558295,
          brierBm: 0.2125, brierRecal: 0.2086, brierClim: 0.2728, brierRecal3: 0.209, brierClim3: 0.273, recalLeClim: true,
        },
        {
          cellId: 'b:2.5/5:h72', holdH: 72, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 379, maxNonOverlappingHolds: 101,
          baseRateFit: 0.114025, yMeanHoldout: 0.215175, pBmMeanHoldout: 0.261497, pRecalMeanHoldout: 0.291016,
          brierBm: 0.1634, brierRecal: 0.1610, brierClim: 0.1791, brierRecal3: 0.161, brierClim3: 0.179, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h0.5', holdH: 0.5, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 1, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.998275, yMeanHoldout: 0.999600, pBmMeanHoldout: 0.999986, pRecalMeanHoldout: 0.998544,
          brierBm: 0.0004, brierRecal: 0.0004, brierClim: 0.0004, brierRecal3: 0.000, brierClim3: 0.000, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h4', holdH: 4, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 23, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.963150, yMeanHoldout: 0.985825, pBmMeanHoldout: 0.993861, pRecalMeanHoldout: 0.977482,
          brierBm: 0.0136, brierRecal: 0.0138, brierClim: 0.0145, brierRecal3: 0.014, brierClim3: 0.014, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h8', holdH: 8, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 46, maxNonOverlappingHolds: 912,
          baseRateFit: 0.914325, yMeanHoldout: 0.963300, pBmMeanHoldout: 0.976678, pRecalMeanHoldout: 0.947741,
          brierBm: 0.0339, brierRecal: 0.0344, brierClim: 0.0378, brierRecal3: 0.034, brierClim3: 0.038, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h24', holdH: 24, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 115, maxNonOverlappingHolds: 304,
          baseRateFit: 0.739175, yMeanHoldout: 0.855400, pBmMeanHoldout: 0.880791, pRecalMeanHoldout: 0.838307,
          brierBm: 0.1149, brierRecal: 0.1140, brierClim: 0.1372, brierRecal3: 0.114, brierClim3: 0.137, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h72', holdH: 72, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 378, maxNonOverlappingHolds: 101,
          baseRateFit: 0.436325, yMeanHoldout: 0.610325, pBmMeanHoldout: 0.651470, pRecalMeanHoldout: 0.628393,
          brierBm: 0.2194, brierRecal: 0.2140, brierClim: 0.2681, brierRecal3: 0.214, brierClim3: 0.268, recalLeClim: true,
        },
        {
          cellId: 'b:1s/2s:h0.5', holdH: 0.5, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 39998, nDoubleTouch: 2, nHoldGap: 2, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.671550, yMeanHoldout: 0.663358, pBmMeanHoldout: 0.637253, pRecalMeanHoldout: 0.622991,
          brierBm: 0.2240, brierRecal: 0.2249, brierClim: 0.2234, brierRecal3: 0.225, brierClim3: 0.223, recalLeClim: false,
        },
        {
          cellId: 'b:1s/2s:h4', holdH: 4, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 18, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.637100, yMeanHoldout: 0.633200, pBmMeanHoldout: 0.637246, pRecalMeanHoldout: 0.620510,
          brierBm: 0.2323, brierRecal: 0.2327, brierClim: 0.2323, brierRecal3: 0.233, brierClim3: 0.232, recalLeClim: false,
        },
        {
          cellId: 'b:1s/2s:h8', holdH: 8, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 55, maxNonOverlappingHolds: 912,
          baseRateFit: 0.618675, yMeanHoldout: 0.616600, pBmMeanHoldout: 0.637237, pRecalMeanHoldout: 0.615514,
          brierBm: 0.2368, brierRecal: 0.2372, brierClim: 0.2364, brierRecal3: 0.237, brierClim3: 0.236, recalLeClim: false,
        },
        {
          cellId: 'b:1s/2s:h24', holdH: 24, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 121, maxNonOverlappingHolds: 304,
          baseRateFit: 0.586750, yMeanHoldout: 0.584325, pBmMeanHoldout: 0.637212, pRecalMeanHoldout: 0.604901,
          brierBm: 0.2457, brierRecal: 0.2442, brierClim: 0.2429, brierRecal3: 0.244, brierClim3: 0.243, recalLeClim: false,
        },
        {
          cellId: 'b:1s/2s:h72', holdH: 72, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 427, maxNonOverlappingHolds: 101,
          baseRateFit: 0.552000, yMeanHoldout: 0.558775, pBmMeanHoldout: 0.637118, pRecalMeanHoldout: 0.601692,
          brierBm: 0.2528, brierRecal: 0.2484, brierClim: 0.2466, brierRecal3: 0.248, brierClim3: 0.247, recalLeClim: false,
        },
      ],
    },
    target_first: {
      pass: false,
      verdict: 'uncalibrated',
      verdictDetail: 'recalibrated Brier above climatology in: b:1/2:h72',
      recalInput: 'p_bm',
      nFitRows: 999912,
      nHoldoutRows: 999983,
      ecePp: 0.118,
      ecePpBm: 1.829,
      recalBins: [
        { lo: null, hi: 0.000000, value: null, nFit: 0 },
        { lo: 0.000000, hi: 0.000000, value: 0.000470, nFit: 99977 },
        { lo: 0.000000, hi: 0.000000, value: 0.002879, nFit: 50010 },
        { lo: 0.000000, hi: 0.000064, value: 0.008781, nFit: 49996 },
        { lo: 0.000064, hi: 0.002141, value: 0.021542, nFit: 49995 },
        { lo: 0.002141, hi: 0.015771, value: 0.042363, nFit: 49996 },
        { lo: 0.015771, hi: 0.035693, value: 0.069947, nFit: 49995 },
        { lo: 0.035693, hi: 0.042298, value: 0.092107, nFit: 49996 },
        { lo: 0.042298, hi: 0.046408, value: 0.078108, nFit: 49995 },
        { lo: 0.046408, hi: 0.050609, value: 0.081347, nFit: 49996 },
        { lo: 0.050609, hi: 0.064074, value: 0.087187, nFit: 49996 },
        { lo: 0.064074, hi: 0.127130, value: 0.114951, nFit: 49995 },
        { lo: 0.127130, hi: 0.213789, value: 0.174414, nFit: 49996 },
        { lo: 0.213789, hi: 0.290381, value: 0.234043, nFit: 49995 },
        { lo: 0.290381, hi: 0.325991, value: 0.292363, nFit: 49996 },
        { lo: 0.325991, hi: 0.335800, value: 0.326213, nFit: 49995 },
        { lo: 0.335800, hi: 0.370957, value: 0.323946, nFit: 49996 },
        { lo: 0.370957, hi: 0.398499, value: 0.389358, nFit: 49990 },
        { lo: 0.398499, hi: 0.401499, value: 0.402812, nFit: 50001 },
        { lo: 0.401499, hi: null, value: 0.392331, nFit: 49996 },
      ],
      reliability: [
        { n: 99999, pMean: 0.000470, yMean: 0.000410, gapPp: 0.006 },
        { n: 99999, pMean: 0.002335, yMean: 0.003040, gapPp: -0.071 },
        { n: 99999, pMean: 0.014886, yMean: 0.014510, gapPp: 0.038 },
        { n: 99998, pMean: 0.051737, yMean: 0.049101, gapPp: 0.264 },
        { n: 99998, pMean: 0.078887, yMean: 0.076982, gapPp: 0.191 },
        { n: 99998, pMean: 0.087292, yMean: 0.087482, gapPp: -0.019 },
        { n: 99998, pMean: 0.133216, yMean: 0.135053, gapPp: -0.184 },
        { n: 99998, pMean: 0.256162, yMean: 0.256995, gapPp: -0.083 },
        { n: 99998, pMean: 0.347819, yMean: 0.346357, gapPp: 0.146 },
        { n: 99998, pMean: 0.396090, yMean: 0.394288, gapPp: 0.180 },
      ],
      reliabilityBm: [
        { n: 99999, pMean: 0.000000, yMean: 0.000450, gapPp: -0.045 },
        { n: 99999, pMean: 0.000000, yMean: 0.002800, gapPp: -0.280 },
        { n: 99999, pMean: 0.000246, yMean: 0.015310, gapPp: -1.506 },
        { n: 99998, pMean: 0.014352, yMean: 0.048691, gapPp: -3.434 },
        { n: 99998, pMean: 0.041499, yMean: 0.080142, gapPp: -3.864 },
        { n: 99998, pMean: 0.049023, yMean: 0.086312, gapPp: -3.729 },
        { n: 99998, pMean: 0.112230, yMean: 0.132563, gapPp: -2.033 },
        { n: 99998, pMean: 0.275459, yMean: 0.258615, gapPp: 1.684 },
        { n: 99998, pMean: 0.356364, yMean: 0.343067, gapPp: 1.330 },
        { n: 99998, pMean: 0.400137, yMean: 0.396268, gapPp: 0.387 },
      ],
      cells: [
        {
          cellId: 'b:0.5/0.75:h0.5', holdH: 0.5, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39999, nDoubleTouch: 1, nHoldGap: 2, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.144200, yMeanHoldout: 0.092652, pBmMeanHoldout: 0.091581, pRecalMeanHoldout: 0.110850,
          brierBm: 0.0794, brierRecal: 0.0790, brierClim: 0.0867, brierRecal3: 0.079, brierClim3: 0.087, recalLeClim: true,
        },
        {
          cellId: 'b:0.5/0.75:h4', holdH: 4, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39996, nDoubleTouch: 4, nHoldGap: 24, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.353696, yMeanHoldout: 0.322257, pBmMeanHoldout: 0.336588, pRecalMeanHoldout: 0.329881,
          brierBm: 0.2132, brierRecal: 0.2129, brierClim: 0.2194, brierRecal3: 0.213, brierClim3: 0.219, recalLeClim: true,
        },
        {
          cellId: 'b:0.5/0.75:h8', holdH: 8, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39998, nDoubleTouch: 2, nHoldGap: 59, maxNonOverlappingHolds: 912,
          baseRateFit: 0.387636, yMeanHoldout: 0.364693, pBmMeanHoldout: 0.377436, pRecalMeanHoldout: 0.370806,
          brierBm: 0.2302, brierRecal: 0.2302, brierClim: 0.2322, brierRecal3: 0.230, brierClim3: 0.232, recalLeClim: true,
        },
        {
          cellId: 'b:0.5/0.75:h24', holdH: 24, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39997, nDoubleTouch: 3, nHoldGap: 125, maxNonOverlappingHolds: 304,
          baseRateFit: 0.397994, yMeanHoldout: 0.396530, pBmMeanHoldout: 0.397565, pRecalMeanHoldout: 0.392008,
          brierBm: 0.2393, brierRecal: 0.2393, brierClim: 0.2393, brierRecal3: 0.239, brierClim3: 0.239, recalLeClim: true,
        },
        {
          cellId: 'b:0.5/0.75:h72', holdH: 72, stopPct: 0.50, targetPct: 0.75, stopSigma: null, targetSigma: null, leverage: null,
          n: 39997, nDoubleTouch: 3, nHoldGap: 406, maxNonOverlappingHolds: 101,
          baseRateFit: 0.402851, yMeanHoldout: 0.401830, pBmMeanHoldout: 0.399833, pRecalMeanHoldout: 0.395974,
          brierBm: 0.2404, brierRecal: 0.2403, brierClim: 0.2404, brierRecal3: 0.240, brierClim3: 0.240, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h0.5', holdH: 0.5, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 2, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.020302, yMeanHoldout: 0.009550, pBmMeanHoldout: 0.003208, pRecalMeanHoldout: 0.013781,
          brierBm: 0.0094, brierRecal: 0.0094, brierClim: 0.0096, brierRecal3: 0.009, brierClim3: 0.010, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h4', holdH: 4, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 39999, nDoubleTouch: 1, nHoldGap: 15, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.154369, yMeanHoldout: 0.105278, pBmMeanHoldout: 0.097203, pRecalMeanHoldout: 0.115034,
          brierBm: 0.0896, brierRecal: 0.0890, brierClim: 0.0966, brierRecal3: 0.089, brierClim3: 0.097, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h8', holdH: 8, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 44, maxNonOverlappingHolds: 912,
          baseRateFit: 0.226461, yMeanHoldout: 0.179275, pBmMeanHoldout: 0.173532, pRecalMeanHoldout: 0.179163,
          brierBm: 0.1414, brierRecal: 0.1407, brierClim: 0.1494, brierRecal3: 0.141, brierClim3: 0.149, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h24', holdH: 24, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 39999, nDoubleTouch: 1, nHoldGap: 123, maxNonOverlappingHolds: 304,
          baseRateFit: 0.306865, yMeanHoldout: 0.285832, pBmMeanHoldout: 0.278944, pRecalMeanHoldout: 0.269456,
          brierBm: 0.2034, brierRecal: 0.2030, brierClim: 0.2046, brierRecal3: 0.203, brierClim3: 0.205, recalLeClim: true,
        },
        {
          cellId: 'b:1/2:h72', holdH: 72, stopPct: 1.00, targetPct: 2.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 400, maxNonOverlappingHolds: 101,
          baseRateFit: 0.333500, yMeanHoldout: 0.337025, pBmMeanHoldout: 0.324251, pRecalMeanHoldout: 0.314379,
          brierBm: 0.2245, brierRecal: 0.2247, brierClim: 0.2235, brierRecal3: 0.225, brierClim3: 0.223, recalLeClim: false,
        },
        {
          cellId: 'b:2.5/5:h0.5', holdH: 0.5, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 4, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.001675, yMeanHoldout: 0.000400, pBmMeanHoldout: 0.000013, pRecalMeanHoldout: 0.001094,
          brierBm: 0.0004, brierRecal: 0.0004, brierClim: 0.0004, brierRecal3: 0.000, brierClim3: 0.000, recalLeClim: true,
        },
        {
          cellId: 'b:2.5/5:h4', holdH: 4, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 20, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.030675, yMeanHoldout: 0.012825, pBmMeanHoldout: 0.005547, pRecalMeanHoldout: 0.018938,
          brierBm: 0.0125, brierRecal: 0.0124, brierClim: 0.0130, brierRecal3: 0.012, brierClim3: 0.013, recalLeClim: true,
        },
        {
          cellId: 'b:2.5/5:h8', holdH: 8, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 44, maxNonOverlappingHolds: 912,
          baseRateFit: 0.065075, yMeanHoldout: 0.031475, pBmMeanHoldout: 0.020940, pRecalMeanHoldout: 0.041875,
          brierBm: 0.0297, brierRecal: 0.0297, brierClim: 0.0316, brierRecal3: 0.030, brierClim3: 0.032, recalLeClim: true,
        },
        {
          cellId: 'b:2.5/5:h24', holdH: 24, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 129, maxNonOverlappingHolds: 304,
          baseRateFit: 0.170800, yMeanHoldout: 0.113650, pBmMeanHoldout: 0.093982, pRecalMeanHoldout: 0.112232,
          brierBm: 0.0964, brierRecal: 0.0955, brierClim: 0.1040, brierRecal3: 0.095, brierClim3: 0.104, recalLeClim: true,
        },
        {
          cellId: 'b:2.5/5:h72', holdH: 72, stopPct: 2.50, targetPct: 5.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 379, maxNonOverlappingHolds: 101,
          baseRateFit: 0.290050, yMeanHoldout: 0.234000, pBmMeanHoldout: 0.212916, pRecalMeanHoldout: 0.209858,
          brierBm: 0.1784, brierRecal: 0.1772, brierClim: 0.1824, brierRecal3: 0.177, brierClim3: 0.182, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h0.5', holdH: 0.5, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 1, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.000275, yMeanHoldout: 0.000050, pBmMeanHoldout: 0.000000, pRecalMeanHoldout: 0.000489,
          brierBm: 0.0001, brierRecal: 0.0001, brierClim: 0.0001, brierRecal3: 0.000, brierClim3: 0.000, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h4', holdH: 4, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 23, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.004300, yMeanHoldout: 0.001175, pBmMeanHoldout: 0.000177, pRecalMeanHoldout: 0.002817,
          brierBm: 0.0012, brierRecal: 0.0012, brierClim: 0.0012, brierRecal3: 0.001, brierClim3: 0.001, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h8', holdH: 8, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 46, maxNonOverlappingHolds: 912,
          baseRateFit: 0.012650, yMeanHoldout: 0.003750, pBmMeanHoldout: 0.001148, pRecalMeanHoldout: 0.007575,
          brierBm: 0.0037, brierRecal: 0.0038, brierClim: 0.0038, brierRecal3: 0.004, brierClim3: 0.004, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h24', holdH: 24, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 115, maxNonOverlappingHolds: 304,
          baseRateFit: 0.049900, yMeanHoldout: 0.022100, pBmMeanHoldout: 0.012683, pRecalMeanHoldout: 0.030736,
          brierBm: 0.0213, brierRecal: 0.0213, brierClim: 0.0224, brierRecal3: 0.021, brierClim3: 0.022, recalLeClim: true,
        },
        {
          cellId: 'b:5/10:h72', holdH: 72, stopPct: 5.00, targetPct: 10.00, stopSigma: null, targetSigma: null, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 378, maxNonOverlappingHolds: 101,
          baseRateFit: 0.154675, yMeanHoldout: 0.085800, pBmMeanHoldout: 0.067836, pRecalMeanHoldout: 0.089297,
          brierBm: 0.0771, brierRecal: 0.0763, brierClim: 0.0832, brierRecal3: 0.076, brierClim3: 0.083, recalLeClim: true,
        },
        {
          cellId: 'b:1s/2s:h0.5', holdH: 0.5, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 39998, nDoubleTouch: 2, nHoldGap: 2, maxNonOverlappingHolds: 14592,
          baseRateFit: 0.062050, yMeanHoldout: 0.067203, pBmMeanHoldout: 0.045447, pRecalMeanHoldout: 0.078711,
          brierBm: 0.0632, brierRecal: 0.0628, brierClim: 0.0627, brierRecal3: 0.063, brierClim3: 0.063, recalLeClim: true,
        },
        {
          cellId: 'b:1s/2s:h4', holdH: 4, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 18, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.072625, yMeanHoldout: 0.076725, pBmMeanHoldout: 0.045464, pRecalMeanHoldout: 0.081567,
          brierBm: 0.0718, brierRecal: 0.0710, brierClim: 0.0709, brierRecal3: 0.071, brierClim3: 0.071, recalLeClim: true,
        },
        {
          cellId: 'b:1s/2s:h8', holdH: 8, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 55, maxNonOverlappingHolds: 912,
          baseRateFit: 0.079750, yMeanHoldout: 0.078450, pBmMeanHoldout: 0.045482, pRecalMeanHoldout: 0.083751,
          brierBm: 0.0734, brierRecal: 0.0725, brierClim: 0.0723, brierRecal3: 0.072, brierClim3: 0.072, recalLeClim: true,
        },
        {
          cellId: 'b:1s/2s:h24', holdH: 24, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 121, maxNonOverlappingHolds: 304,
          baseRateFit: 0.088825, yMeanHoldout: 0.088625, pBmMeanHoldout: 0.045632, pRecalMeanHoldout: 0.086591,
          brierBm: 0.0826, brierRecal: 0.0809, brierClim: 0.0808, brierRecal3: 0.081, brierClim3: 0.081, recalLeClim: true,
        },
        {
          cellId: 'b:1s/2s:h72', holdH: 72, stopPct: null, targetPct: null, stopSigma: 1.0, targetSigma: 2.0, leverage: null,
          n: 40000, nDoubleTouch: 0, nHoldGap: 427, maxNonOverlappingHolds: 101,
          baseRateFit: 0.108700, yMeanHoldout: 0.099450, pBmMeanHoldout: 0.045930, pRecalMeanHoldout: 0.085431,
          brierBm: 0.0925, brierRecal: 0.0898, brierClim: 0.0896, brierRecal3: 0.090, brierClim3: 0.090, recalLeClim: true,
        },
      ],
    },
    liquidation: {
      pass: true,
      verdict: 'calibrated',
      verdictDetail: 'all three clauses hold',
      recalInput: 'd_over_sigma_h',
      nFitRows: 360000,
      nHoldoutRows: 360000,
      ecePp: 0.516,
      ecePpBm: 2.094,
      recalBins: [
        { lo: null, hi: 0.170549, value: 0.894500, nFit: 18000 },
        { lo: 0.170549, hi: 0.260929, value: 0.812333, nFit: 18000 },
        { lo: 0.260929, hi: 0.355504, value: 0.734278, nFit: 18000 },
        { lo: 0.355504, hi: 0.452669, value: 0.665389, nFit: 18000 },
        { lo: 0.452669, hi: 0.557494, value: 0.589778, nFit: 18000 },
        { lo: 0.557494, hi: 0.673382, value: 0.516889, nFit: 18000 },
        { lo: 0.673382, hi: 0.806275, value: 0.443611, nFit: 18000 },
        { lo: 0.806275, hi: 0.952643, value: 0.371444, nFit: 18000 },
        { lo: 0.952643, hi: 1.111276, value: 0.304056, nFit: 18000 },
        { lo: 1.111276, hi: 1.291123, value: 0.245667, nFit: 18000 },
        { lo: 1.291123, hi: 1.495343, value: 0.201167, nFit: 18000 },
        { lo: 1.495343, hi: 1.734436, value: 0.158222, nFit: 18000 },
        { lo: 1.734436, hi: 2.019898, value: 0.116167, nFit: 18000 },
        { lo: 2.019898, hi: 2.366299, value: 0.079167, nFit: 18000 },
        { lo: 2.366299, hi: 2.812809, value: 0.057556, nFit: 18000 },
        { lo: 2.812809, hi: 3.411972, value: 0.037167, nFit: 18000 },
        { lo: 3.411972, hi: 4.252616, value: 0.019611, nFit: 18000 },
        { lo: 4.252616, hi: 5.518179, value: 0.009056, nFit: 18000 },
        { lo: 5.518179, hi: 7.918932, value: 0.003944, nFit: 18000 },
        { lo: 7.918932, hi: null, value: 0.000722, nFit: 18000 },
      ],
      reliability: [
        { n: 36000, pMean: 0.001275, yMean: 0.001278, gapPp: -0.000 },
        { n: 36000, pMean: 0.006496, yMean: 0.007389, gapPp: -0.089 },
        { n: 36000, pMean: 0.023496, yMean: 0.021917, gapPp: 0.158 },
        { n: 36000, pMean: 0.053768, yMean: 0.045722, gapPp: 0.805 },
        { n: 36000, pMean: 0.100967, yMean: 0.095500, gapPp: 0.547 },
        { n: 36000, pMean: 0.182552, yMean: 0.174389, gapPp: 0.816 },
        { n: 36000, pMean: 0.287723, yMean: 0.281500, gapPp: 0.622 },
        { n: 36000, pMean: 0.437900, yMean: 0.441167, gapPp: -0.327 },
        { n: 36000, pMean: 0.603741, yMean: 0.613472, gapPp: -0.973 },
        { n: 36000, pMean: 0.798778, yMean: 0.790528, gapPp: 0.825 },
      ],
      reliabilityBm: [
        { n: 36000, pMean: 0.000000, yMean: 0.002056, gapPp: -0.206 },
        { n: 36000, pMean: 0.000001, yMean: 0.006500, gapPp: -0.650 },
        { n: 36000, pMean: 0.000473, yMean: 0.022917, gapPp: -2.244 },
        { n: 36000, pMean: 0.009313, yMean: 0.045833, gapPp: -3.652 },
        { n: 36000, pMean: 0.049287, yMean: 0.095472, gapPp: -4.619 },
        { n: 36000, pMean: 0.139550, yMean: 0.175278, gapPp: -3.573 },
        { n: 36000, pMean: 0.279962, yMean: 0.283611, gapPp: -0.365 },
        { n: 36000, pMean: 0.452933, yMean: 0.441944, gapPp: 1.099 },
        { n: 36000, pMean: 0.630184, yMean: 0.609167, gapPp: 2.102 },
        { n: 36000, pMean: 0.814433, yMean: 0.790083, gapPp: 2.435 },
      ],
      cells: [
        {
          cellId: 'liq:10x:h4', holdH: 4, stopPct: null, targetPct: null, stopSigma: null, targetSigma: null, leverage: 10,
          n: 40000, nDoubleTouch: 0, nHoldGap: 24, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.005600, yMeanHoldout: 0.001625, pBmMeanHoldout: 0.000297, pRecalMeanHoldout: 0.004495,
          brierBm: 0.0016, brierRecal: 0.0016, brierClim: 0.0016, brierRecal3: 0.002, brierClim3: 0.002, recalLeClim: true,
        },
        {
          cellId: 'liq:10x:h24', holdH: 24, stopPct: null, targetPct: null, stopSigma: null, targetSigma: null, leverage: 10,
          n: 40000, nDoubleTouch: 0, nHoldGap: 138, maxNonOverlappingHolds: 304,
          baseRateFit: 0.064350, yMeanHoldout: 0.025650, pBmMeanHoldout: 0.018006, pRecalMeanHoldout: 0.043544,
          brierBm: 0.0247, brierRecal: 0.0251, brierClim: 0.0265, brierRecal3: 0.025, brierClim3: 0.026, recalLeClim: true,
        },
        {
          cellId: 'liq:10x:h72', holdH: 72, stopPct: null, targetPct: null, stopSigma: null, targetSigma: null, leverage: 10,
          n: 40000, nDoubleTouch: 0, nHoldGap: 383, maxNonOverlappingHolds: 101,
          baseRateFit: 0.199975, yMeanHoldout: 0.106225, pBmMeanHoldout: 0.090089, pRecalMeanHoldout: 0.124220,
          brierBm: 0.0920, brierRecal: 0.0913, brierClim: 0.1037, brierRecal3: 0.091, brierClim3: 0.104, recalLeClim: true,
        },
        {
          cellId: 'liq:20x:h4', holdH: 4, stopPct: null, targetPct: null, stopSigma: null, targetSigma: null, leverage: 20,
          n: 40000, nDoubleTouch: 0, nHoldGap: 29, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.047300, yMeanHoldout: 0.021050, pBmMeanHoldout: 0.011825, pRecalMeanHoldout: 0.033015,
          brierBm: 0.0200, brierRecal: 0.0202, brierClim: 0.0213, brierRecal3: 0.020, brierClim3: 0.021, recalLeClim: true,
        },
        {
          cellId: 'liq:20x:h24', holdH: 24, stopPct: null, targetPct: null, stopSigma: null, targetSigma: null, leverage: 20,
          n: 40000, nDoubleTouch: 0, nHoldGap: 122, maxNonOverlappingHolds: 304,
          baseRateFit: 0.257800, yMeanHoldout: 0.164225, pBmMeanHoldout: 0.146164, pRecalMeanHoldout: 0.175902,
          brierBm: 0.1254, brierRecal: 0.1242, brierClim: 0.1460, brierRecal3: 0.124, brierClim3: 0.146, recalLeClim: true,
        },
        {
          cellId: 'liq:20x:h72', holdH: 72, stopPct: null, targetPct: null, stopSigma: null, targetSigma: null, leverage: 20,
          n: 40000, nDoubleTouch: 0, nHoldGap: 402, maxNonOverlappingHolds: 101,
          baseRateFit: 0.472375, yMeanHoldout: 0.356300, pBmMeanHoldout: 0.336125, pRecalMeanHoldout: 0.342553,
          brierBm: 0.2155, brierRecal: 0.2128, brierClim: 0.2428, brierRecal3: 0.213, brierClim3: 0.243, recalLeClim: true,
        },
        {
          cellId: 'liq:50x:h4', holdH: 4, stopPct: null, targetPct: null, stopSigma: null, targetSigma: null, leverage: 50,
          n: 40000, nDoubleTouch: 0, nHoldGap: 30, maxNonOverlappingHolds: 1824,
          baseRateFit: 0.324275, yMeanHoldout: 0.237225, pBmMeanHoldout: 0.239710, pRecalMeanHoldout: 0.258645,
          brierBm: 0.1518, brierRecal: 0.1514, brierClim: 0.1885, brierRecal3: 0.151, brierClim3: 0.189, recalLeClim: true,
        },
        {
          cellId: 'liq:50x:h24', holdH: 24, stopPct: null, targetPct: null, stopSigma: null, targetSigma: null, leverage: 50,
          n: 40000, nDoubleTouch: 0, nHoldGap: 148, maxNonOverlappingHolds: 304,
          baseRateFit: 0.651375, yMeanHoldout: 0.566850, pBmMeanHoldout: 0.565821, pRecalMeanHoldout: 0.552071,
          brierBm: 0.2223, brierRecal: 0.2217, brierClim: 0.2527, brierRecal3: 0.222, brierClim3: 0.253, recalLeClim: true,
        },
        {
          cellId: 'liq:50x:h72', holdH: 72, stopPct: null, targetPct: null, stopSigma: null, targetSigma: null, leverage: 50,
          n: 40000, nDoubleTouch: 0, nHoldGap: 388, maxNonOverlappingHolds: 101,
          baseRateFit: 0.794275, yMeanHoldout: 0.746425, pBmMeanHoldout: 0.730483, pRecalMeanHoldout: 0.712583,
          brierBm: 0.1862, brierRecal: 0.1873, brierClim: 0.1916, brierRecal3: 0.187, brierClim3: 0.192, recalLeClim: true,
        },
      ],
    },
  },
  provenance: {
    version: 'odds-v1',
    stage: 'holdout',
    preregistrationSha256: '1a203e1f797c667f7603706c58fb236c8d02494ed6fb00b855ed873585a38c48',
    archiveManifestSha256: 'cddc48493d06ba7160fdf8bd0e429e39e8785d4bb81d9f8cd40df15e2d01bfe7',
    archiveCount: 272,
    archiveChecksums: [
      { file: '1000PEPEUSDT-1m-2024-01.zip', sha256: 'c9928a17bf71887eabf8714e51ab42b61b52f4c0656ab24a658ef3b3d6159a3a' },
      { file: '1000PEPEUSDT-1m-2024-02.zip', sha256: '547e88f18c7287cc5679528989ce4b0e011ad5d36da83d5c66002d307e177002' },
      { file: '1000PEPEUSDT-1m-2024-03.zip', sha256: '5e126846002a187ccca4c210c1d43364234cb4b2a1a8925d6ea42f5f1efe5a1b' },
      { file: '1000PEPEUSDT-1m-2024-04.zip', sha256: 'd1c4fb550f7756e97f1acf8deb517bb5e1f62855598ab9ed8ba126617ef670c9' },
      { file: '1000PEPEUSDT-1m-2024-05.zip', sha256: '66147906e8597e7336a9dcc1d46309360ebf72a62938be806d9a1af3811679fd' },
      { file: '1000PEPEUSDT-1m-2024-06.zip', sha256: 'ff1598f5233a7529be8ae084182c332bc38ac0a10d34c149e82b9d0a0180c02e' },
      { file: '1000PEPEUSDT-1m-2024-07.zip', sha256: 'b7c782842a93386ef52452363d268a107a39cc693a679f598fdc89064a4021be' },
      { file: '1000PEPEUSDT-1m-2024-08.zip', sha256: '2cd0a987d14057c70df41c5f32298adab1e38cd2e47c9e04c3f4ad3c0bd65cb5' },
      { file: '1000PEPEUSDT-1m-2024-09.zip', sha256: '1f7a8628b91a7f72aa5ce35a89c1ce9531d4bb91848d1073326610034f2af12b' },
      { file: '1000PEPEUSDT-1m-2024-10.zip', sha256: '7f3f4135fd5161315ea97a8813632dbf5224b959dc881484038640c5cdbe3232' },
      { file: '1000PEPEUSDT-1m-2024-11.zip', sha256: 'ad8ed28a3e571392c38ded2900d70f6137bb37db82d33adfb51d8a45844abac4' },
      { file: '1000PEPEUSDT-1m-2024-12.zip', sha256: '01288b5fbb902b93444e1c0bb0a84c00576abaa4db1b2c4585f07a2a0a375735' },
      { file: '1000PEPEUSDT-1m-2025-01.zip', sha256: 'e6f897f553e3999860e9bdd07768f30e1e65102cc9d5500252d4becd6eeca33b' },
      { file: '1000PEPEUSDT-1m-2025-02.zip', sha256: '10248c208e9bb94c54d46172e912099ec331c6786847cecaa53269e34a3343df' },
      { file: '1000PEPEUSDT-1m-2025-03.zip', sha256: '3cbde4e9b719ecfdfe50a23aec5ec3bfd8375568fb10d750a7cd7e99d875e9c3' },
      { file: '1000PEPEUSDT-1m-2025-04.zip', sha256: '48064f08dd0712d9e1e791ee0073b76a33bb52fb57fc1caba2179a8568707a7b' },
      { file: '1000PEPEUSDT-1m-2025-05.zip', sha256: 'b720901b27ad0d2a80dc01027bb3311ad34054c940bbad37c8801ca03953dc85' },
      { file: '1000PEPEUSDT-1m-2025-06.zip', sha256: '975a78d9939d753b02ea22a910bdfefa245eff28c278af415cc39e4785602a8a' },
      { file: '1000PEPEUSDT-1m-2025-07.zip', sha256: '9fbfda4efba8a57c08dce2bd884499daccbc1673d5976d06ae911f1158f882f2' },
      { file: '1000PEPEUSDT-1m-2025-08.zip', sha256: '8a4ebb7614b34760762b9037fcd3a468ca657ebed65e81230e4a5e42214599a1' },
      { file: '1000PEPEUSDT-1m-2025-09.zip', sha256: 'a2030f2f86aebcc9c843fab0fcbe99495f4145fd60a9f1519a48b5536728fb91' },
      { file: '1000PEPEUSDT-1m-2025-10.zip', sha256: '84b4751a3fafd9e36e794b3835ed1983be3eba0a5c6544d3d73939ff561e4119' },
      { file: '1000PEPEUSDT-1m-2025-11.zip', sha256: '598354cef8644c46fdb8137aab16f9afd906cbc5afb355cfdb93f1d009385719' },
      { file: '1000PEPEUSDT-1m-2025-12.zip', sha256: '5aa9f4b54ba1195b46051dc13001553534b711a51a190adfc7b0f32fc75a62f5' },
      { file: '1000PEPEUSDT-1m-2026-01.zip', sha256: '90ec604948857db8af14f0fec581ec6d0e58a5e71c800e104aea1508604b1952' },
      { file: '1000PEPEUSDT-1m-2026-02.zip', sha256: 'b516c6a7010a2e6eb2c14d3c1afb3fe8ea317a36d1bd2a006f5b6e567b276136' },
      { file: '1000PEPEUSDT-1m-2026-03.zip', sha256: '7c713dc67f922244054acef973ec3b42203c8da2f9e0286b0d7236cfb8921ab4' },
      { file: '1000PEPEUSDT-1m-2026-04.zip', sha256: '7f4b7f1252a3f199a4250e45d034ac44cea412e5a3332d62c336511d17317c00' },
      { file: '1000PEPEUSDT-1m-2026-05.zip', sha256: 'b4d7ccd09a324fb5aa9743f819ab3e0f4c922468412f408888b00850bfabf5e0' },
      { file: '1000PEPEUSDT-1m-2026-06.zip', sha256: '7e864b261ad28e21d866a48199ec5330dac370b02d3e91dec3701add9046a2e0' },
      { file: '1000PEPEUSDT-1m-2026-07.zip', sha256: '85fdfdac2864d787d5e7aee73e1be6428c92047e25d7b9a88ba400db79ed271f' },
      { file: '1000PEPEUSDT-1m-2026-08.zip', sha256: '25339b8345ac6a97bb56ee1474271a80925c252d9abb1fb99a5bc0cf576edab4' },
      { file: '1000PEPEUSDT-1m-2026-09.zip', sha256: 'ed0422b6280898e2da36b3dc3b2ad1116e6e1d52765bd915dfdd3d4dcedd20f4' },
      { file: '1000PEPEUSDT-1m-2026-10.zip', sha256: 'd6f64f1c9646fb2b01a8496ff93b1f9c86613c9abdf65cc65082d2c9b01451f3' },
      { file: 'BNBUSDT-1m-2024-01.zip', sha256: 'a3afc4ef24e04af6f868f8415826ed600e7c2f9898e5e88dd1287cb6b55aca54' },
      { file: 'BNBUSDT-1m-2024-02.zip', sha256: 'cb8d36292f0de017f76b8ec8dba381d82119c03c51913b557be3fad7981c1868' },
      { file: 'BNBUSDT-1m-2024-03.zip', sha256: '0e3f3116dbbaad0276c959b00c18c1348c61ac411fbfae803e11623ceff6a8d1' },
      { file: 'BNBUSDT-1m-2024-04.zip', sha256: 'e1aad78ef0ff9e7d91c554523c7513636470c61ac03594cae8fe54e703a532b6' },
      { file: 'BNBUSDT-1m-2024-05.zip', sha256: '02a4eda6f534c1dddb793f897783b278b52b1fc020f6c9b15b10193238599372' },
      { file: 'BNBUSDT-1m-2024-06.zip', sha256: '45aaf57327973e51b63c0321c047a057e048b872756b1857e7bb167680553b63' },
      { file: 'BNBUSDT-1m-2024-07.zip', sha256: '1d762f3e5acac93ab7255b58aad6abf46d8ce7786795a3a60e68a2e6150f5d02' },
      { file: 'BNBUSDT-1m-2024-08.zip', sha256: 'd65cbbe6391a000b148d3724f291f1e38b9835b857df74b3dfc85dfc51e4213c' },
      { file: 'BNBUSDT-1m-2024-09.zip', sha256: 'c3e420c19b11ed71a8aeca43f0f3e3dd01978808552538e8d6926977f71f7f9f' },
      { file: 'BNBUSDT-1m-2024-10.zip', sha256: '5fc68f2257837ded1da2512a29d80a74193e4b2771e376da94572252e93a9cb7' },
      { file: 'BNBUSDT-1m-2024-11.zip', sha256: 'f32a66628e0fe3f1bc3662cdaf7e3cbe32ac930065a8bf63044db7be685350de' },
      { file: 'BNBUSDT-1m-2024-12.zip', sha256: 'a7b148a20fe8a60a1116b42c4c4999fe19b5a3c68344d31e53923f1564beab3a' },
      { file: 'BNBUSDT-1m-2025-01.zip', sha256: 'ac1dca1d605bd4922c6d7368442228202514eeee95312afc72c730114ccabda1' },
      { file: 'BNBUSDT-1m-2025-02.zip', sha256: 'e6068cd1a2b5279596b3acabc16c9fe970ac5a0fb11e84cacceb7b6c6eef0c4a' },
      { file: 'BNBUSDT-1m-2025-03.zip', sha256: '91c6449785bab462c273022e4a7787df6a6e83f3d34303ee3399b7fead8b784d' },
      { file: 'BNBUSDT-1m-2025-04.zip', sha256: '2882ea15660c467b073bc360c160ba35c0625d253dc2a64fd98cc80b7965b2dd' },
      { file: 'BNBUSDT-1m-2025-05.zip', sha256: '9aff7aeeca84783e43ea07d0eb7c1c91486dd12040d1a12540685573801c6235' },
      { file: 'BNBUSDT-1m-2025-06.zip', sha256: '93f97cdce0133f6a0c7c864128037b43556d614bbcfc2324b317aa7f8b24ed45' },
      { file: 'BNBUSDT-1m-2025-07.zip', sha256: 'b5a04a1f716d55bfee12c998a72664f21049af6fb5b0b1f4128e4fb1f27e05e3' },
      { file: 'BNBUSDT-1m-2025-08.zip', sha256: '439d334120b2af2dd3001f6a759a97e645fc5fc3be919518f9ae34ff1a4bcaf8' },
      { file: 'BNBUSDT-1m-2025-09.zip', sha256: '22906474a1c9ca482d8442e404797e50baeffe989ba7f3018aef7648dc6cc4ee' },
      { file: 'BNBUSDT-1m-2025-10.zip', sha256: '0e3cda80472529d3fcde8047527b113c5ebcd536737f2452e9354a6258c7fe2b' },
      { file: 'BNBUSDT-1m-2025-11.zip', sha256: '7e44597b191b1c8f1b140cb5aac7d64e21fc9160062e7a1dd391c43aed9f4f44' },
      { file: 'BNBUSDT-1m-2025-12.zip', sha256: '5918b8a27da66f7c44d4697056c49a3d86580931a9908d0613b9f745f2b78a67' },
      { file: 'BNBUSDT-1m-2026-01.zip', sha256: 'e13e987aa52f282d2ac6b85c8369849a347dbfe935ba8ddced48795f3851a349' },
      { file: 'BNBUSDT-1m-2026-02.zip', sha256: 'a92c416377f1a0ed5d57d1483f3bf99e0d7d5432d1f539726dcd3c2ab5fd6a16' },
      { file: 'BNBUSDT-1m-2026-03.zip', sha256: '3d2bb8636eec0ade8efbee102c13d99411913042b269a616ec602f8b1c4eb26c' },
      { file: 'BNBUSDT-1m-2026-04.zip', sha256: 'f1623d510cfeafc9a02688c83418b7ad6e81294c44a499915e821a8e72a2d434' },
      { file: 'BNBUSDT-1m-2026-05.zip', sha256: '818b9cc3b67a0625f9079bc221b19c5de8ee7ad8fd4feb4537a6691163a54d3b' },
      { file: 'BNBUSDT-1m-2026-06.zip', sha256: '72a8259f55efa9bcfe3878a4c32d242fd2004b518e28112be6a28b4fd6784c4b' },
      { file: 'BNBUSDT-1m-2026-07.zip', sha256: '3db410739c41216c47d80750dd29f4f5c60e62a8756439b4af18ee8e4afd2f6a' },
      { file: 'BNBUSDT-1m-2026-08.zip', sha256: '720458d20a8e5ee8519abc29b7fec1c7e4e074d675ef3fb11fcbfa5d0184a2c1' },
      { file: 'BNBUSDT-1m-2026-09.zip', sha256: 'e467378d964bad51920c0ea87517503d644e7d1ce001a0e742c2edd57c463097' },
      { file: 'BNBUSDT-1m-2026-10.zip', sha256: '06c174c748677e944bcfb59bfafcb92bfa5910e84b116c8e03d30c82745f2437' },
      { file: 'BTCUSDT-1m-2024-01.zip', sha256: '21eeac04a76a7a35b10467e5e752fb2f8cff77cdeb57df6b50a23ce8d69bb190' },
      { file: 'BTCUSDT-1m-2024-02.zip', sha256: '1407acbf8ad99911bdf582805699b7e85fdbc346dbe12618ce8b6369f0d8058d' },
      { file: 'BTCUSDT-1m-2024-03.zip', sha256: '040b8e448e4243072b88b0d9908dfebed91bba943b75f4e831fa5337a2e1dab9' },
      { file: 'BTCUSDT-1m-2024-04.zip', sha256: '6a41f002da0c8e3f60bd46c841ea4ed766fb195764ad3b6b10e4f508d29c2eb7' },
      { file: 'BTCUSDT-1m-2024-05.zip', sha256: '42de617ed643def54b5a2c3fceb7cd2edec91aafaa01104a097b2ded5c5122d4' },
      { file: 'BTCUSDT-1m-2024-06.zip', sha256: '93499da4990fec5471bb0d73c91116e7d20a8b2697d7a4491665d6d1b8e85c85' },
      { file: 'BTCUSDT-1m-2024-07.zip', sha256: '97f9cd5104a33828c5c2d8d03a2796d600102ab88737d1c6da515b9609540c3c' },
      { file: 'BTCUSDT-1m-2024-08.zip', sha256: 'f69dbcebfd7108dc97825bd6c35d8d9a51745082f66617cb69de888e867e8e89' },
      { file: 'BTCUSDT-1m-2024-09.zip', sha256: '16fe2e13728236bfbd3efee99671612daadeea3b62dfd55d8874feae9faa4946' },
      { file: 'BTCUSDT-1m-2024-10.zip', sha256: 'aa8c79ad120a8d870e23276d1ad5966f99f59bc0a1886ef5927a3808a5efee36' },
      { file: 'BTCUSDT-1m-2024-11.zip', sha256: '9c3dad038f4b043ec51d4200f57d15a0a07b3fc32b3ea3dca6a96543b9624941' },
      { file: 'BTCUSDT-1m-2024-12.zip', sha256: 'bfce141d2a152c2b94d85b797fe18ebfa195fa0e6091a7ccc06663ae1309466f' },
      { file: 'BTCUSDT-1m-2025-01.zip', sha256: 'b69ca5b2c2d1ae00d68d2790d09138cb2a44085ff19e0da5dc98b569ea7e489e' },
      { file: 'BTCUSDT-1m-2025-02.zip', sha256: 'd84ca981d06ee6491e16597f8d43955f62cab399a9f4b6efc2ee1b4d3a37f0fc' },
      { file: 'BTCUSDT-1m-2025-03.zip', sha256: '4837163333c9c9978255b8870a5a6de1bc48bd22a6c72fef54665a8d4e70b4df' },
      { file: 'BTCUSDT-1m-2025-04.zip', sha256: '87bca047ca7e8b1d27913091255018e121210276726c5aa445e85da6f56e2dcc' },
      { file: 'BTCUSDT-1m-2025-05.zip', sha256: '7acab7e40a74db53a2d6c35373ebe327eefa85b98f8c92fbe58755881e3841ee' },
      { file: 'BTCUSDT-1m-2025-06.zip', sha256: '78872b32c4d0bbc2d89a0459539b90cff47de08a9a56fdf8d233943a32e78efc' },
      { file: 'BTCUSDT-1m-2025-07.zip', sha256: 'cf5fe0891c80e68d2d613eb5457100b7d886eee8cc913ccdd96ef45e757a5aaf' },
      { file: 'BTCUSDT-1m-2025-08.zip', sha256: 'eaf41354fc1aa96eac94ee50b3fda603cd595f95030ebf30b2ab5bea7a4462c3' },
      { file: 'BTCUSDT-1m-2025-09.zip', sha256: 'c296ba45c215934e9750ca82846c7b5d14be661649d8e4423eac834cf57330dc' },
      { file: 'BTCUSDT-1m-2025-10.zip', sha256: 'bb7f53350fe27b6d8e38b5856ffc43f9ecda9d568d5bf31d0db0cd011da7100f' },
      { file: 'BTCUSDT-1m-2025-11.zip', sha256: '981da0b054f99b959fe6245fb363336b46908d358f37251d59bad308f375bc54' },
      { file: 'BTCUSDT-1m-2025-12.zip', sha256: '2d5b2e1887dac1dfe450010877de7203a72e19df7a771067b980bbb07ad3069c' },
      { file: 'BTCUSDT-1m-2026-01.zip', sha256: '58e9c620a6acda209d25766b3cf4262f3104649f5c26f247d933e0da8bb7946f' },
      { file: 'BTCUSDT-1m-2026-02.zip', sha256: '805626ad2dc5b704d52c211996d12e9e4b1be234998f3dba4b3d34ff79be0337' },
      { file: 'BTCUSDT-1m-2026-03.zip', sha256: 'c472a865f230bf1b5b17e124770a83c083144e3e11a115733288fb8f3e3b8baa' },
      { file: 'BTCUSDT-1m-2026-04.zip', sha256: '515b86570f0c6924f6dc2cf90589d3db90f3de9c6bfd9a22dde0429995dc5405' },
      { file: 'BTCUSDT-1m-2026-05.zip', sha256: 'd91548e94220d5211bb32447cc4b604ee266d145f2092edc5ec613328cbbc20a' },
      { file: 'BTCUSDT-1m-2026-06.zip', sha256: '9b214199eb5063585c7ed0f59ba19323326d68ac024b85106713989399204490' },
      { file: 'BTCUSDT-1m-2026-07.zip', sha256: 'f18440bb58f0c7e1ff63cbb906132002877c4914540c8aebab920da6937cff73' },
      { file: 'BTCUSDT-1m-2026-08.zip', sha256: 'adfd0846ea580681aeb18a6bdf06660dcfcc1a7b6819ea2eecfc3c53240ec67a' },
      { file: 'BTCUSDT-1m-2026-09.zip', sha256: 'e1a821b5bf6b48d57da01c3e390b8a467a698155def5c18c2c63c0eb044a3247' },
      { file: 'BTCUSDT-1m-2026-10.zip', sha256: '580bbf821130c6516f0b15819292beae79fd3d08498a0965fe8529308babf16b' },
      { file: 'DOGEUSDT-1m-2024-01.zip', sha256: '8c14611d5e997acc3ba80622718dcc1074b501c9021617efab1da6c5d06c7459' },
      { file: 'DOGEUSDT-1m-2024-02.zip', sha256: 'e09e8a298e3ea05fffa4098956fab52ecccc1a27ff7c8714dd49e5d027426c63' },
      { file: 'DOGEUSDT-1m-2024-03.zip', sha256: '9d69b85fdbd548606d4588be6c1eeb221188ac221d078c62b75f59035f396487' },
      { file: 'DOGEUSDT-1m-2024-04.zip', sha256: '7c2d63e1d177e440d14ee041b22f8d254d7d3fb89f5f555a1fe6b3352963a430' },
      { file: 'DOGEUSDT-1m-2024-05.zip', sha256: '3c4ecebd6b9959d5962d5044073d5ff957afc37caec1766962e27533abae9c2f' },
      { file: 'DOGEUSDT-1m-2024-06.zip', sha256: 'e7f4ad585a013a7cb46aa266c4d0140f9fc02a23d7077d36e79e42076efd9f17' },
      { file: 'DOGEUSDT-1m-2024-07.zip', sha256: 'cac7c6189b7723fe228ee75695634a7224e2325a24e2fc066dae37cf4fe008e3' },
      { file: 'DOGEUSDT-1m-2024-08.zip', sha256: '5e7fd110ebd2cd99d3a43fb253206d96c6a2d694b16dbfd48e23a5b9076be49d' },
      { file: 'DOGEUSDT-1m-2024-09.zip', sha256: 'c5a42879a278e4b12a69d4156b6a6dec4ee4bde53be9bdbf05e5a6d661cf0e72' },
      { file: 'DOGEUSDT-1m-2024-10.zip', sha256: 'e37aeacb3b453a0800be4df79aae1b0637bd58441ba03e5fbd6f9b4bf8c7fc2a' },
      { file: 'DOGEUSDT-1m-2024-11.zip', sha256: 'effde135f4c2497d6ccbc4b44d04e583dd3faeb21bb46f589e360aa2710b649b' },
      { file: 'DOGEUSDT-1m-2024-12.zip', sha256: '1f6b940265db6d595f294e5752616c564bbf00ede60c676abdc3093c3e4e9729' },
      { file: 'DOGEUSDT-1m-2025-01.zip', sha256: '221d5ef5c41fedfefc358790c0d5632b198b17d02187706c4a6de655019e06b5' },
      { file: 'DOGEUSDT-1m-2025-02.zip', sha256: '15cdc4c2fd8340f5957f72164ef6af28e01f3396daebdd3d73fbb7faf4e28c4f' },
      { file: 'DOGEUSDT-1m-2025-03.zip', sha256: '1a6f146aba835867a47220663d4cb72de99d6e8d166f4cb2bf145ca5ec7140d9' },
      { file: 'DOGEUSDT-1m-2025-04.zip', sha256: '05389c77e27693c6cc89c4f38f0afe1e945414c1c145d93e050b478f95e4a947' },
      { file: 'DOGEUSDT-1m-2025-05.zip', sha256: '9e0b44b6ac09e3c09ad1385e39aa690f9624b6b703f2691b1b3e9e7fada508c7' },
      { file: 'DOGEUSDT-1m-2025-06.zip', sha256: 'd699cec9a9a89cb7b037c49943751806b5bc840335a7330b1d090494e247e6e9' },
      { file: 'DOGEUSDT-1m-2025-07.zip', sha256: '6c6858a61ec39254b54a40fd864bef0cacd99a3a244bb9b0e5cec0acbe6eb631' },
      { file: 'DOGEUSDT-1m-2025-08.zip', sha256: '1a69ffc39419bb27c12e019de4809e086e40bf620e40e8a044762ba62095026e' },
      { file: 'DOGEUSDT-1m-2025-09.zip', sha256: '34dac0a3873c158dd3e6126719e0e931ee305f6a1ce56e1a68c5c05b00284b3d' },
      { file: 'DOGEUSDT-1m-2025-10.zip', sha256: 'c2e2ef77ee80bd0d0fef438a5f24dc2f4765de6e3ef0ab36797d1bfb20731bd5' },
      { file: 'DOGEUSDT-1m-2025-11.zip', sha256: '613eba1df328da3b171bd0fe975e2dd1047e0ac535c49a71aad0649ba3da4d6c' },
      { file: 'DOGEUSDT-1m-2025-12.zip', sha256: 'c7d230dcded82fe00f47546094318bb67b7477fe202aac48075237f30cda8840' },
      { file: 'DOGEUSDT-1m-2026-01.zip', sha256: 'b1461ec0ea96fe535e72780b698471907136df72c97a360628c6b65ae6dd5cae' },
      { file: 'DOGEUSDT-1m-2026-02.zip', sha256: '2fa5c67037194c73e823abb111331334e07e5d4f0eaa6704fd879983971e8755' },
      { file: 'DOGEUSDT-1m-2026-03.zip', sha256: 'ba4758aaa2fb1bd5be4f120d21cf5c94d7e315d38918080ee880b36dc60b7841' },
      { file: 'DOGEUSDT-1m-2026-04.zip', sha256: '31a8edfd1f029e3ee08d7824b6352e898828cc8d3e2c71b7cd02b3c9b2637bf5' },
      { file: 'DOGEUSDT-1m-2026-05.zip', sha256: '109a1d0020c4710c1aa86b8773795b21326d038d795b224e1758bf9091c4e110' },
      { file: 'DOGEUSDT-1m-2026-06.zip', sha256: '90b1a9a55146505876a5b0469b69e8606194b018beec06094be8b4babd37c8b4' },
      { file: 'DOGEUSDT-1m-2026-07.zip', sha256: '17c5085d1f95d7b4c50d5d4e5dc7cdafb0fbe61664d66c4a711a03289ede4d0d' },
      { file: 'DOGEUSDT-1m-2026-08.zip', sha256: 'bce45b036618e8d7d1fc370de004813e7d055e807657fabd730833fe77b63739' },
      { file: 'DOGEUSDT-1m-2026-09.zip', sha256: '6a2dd23e5b5a1c259ec2af3f2bcda0d2459131f50b8128199541921cccb4d523' },
      { file: 'DOGEUSDT-1m-2026-10.zip', sha256: 'e52d7248e9127478f80ccd98f0915f6a3ae280af2f2369f3ff2ff84987f4dec9' },
      { file: 'ETHUSDT-1m-2024-01.zip', sha256: '7fa68ec5fedc6eef175ed0af6e9f252062f6ceaca016106c265e6e4b724b5ef2' },
      { file: 'ETHUSDT-1m-2024-02.zip', sha256: 'de3f91fcd929d207b4382afd7a728c0f44527d6bdbcb0a585b01b0fe001e24ab' },
      { file: 'ETHUSDT-1m-2024-03.zip', sha256: 'dd10515a9b010920bac628f2ec600405ff8e41de7d0f81694fbf391ca54b86b2' },
      { file: 'ETHUSDT-1m-2024-04.zip', sha256: '1856da8b501dbb831b9a5490e99be8564433c4a4d46de89200f0258c74dd4790' },
      { file: 'ETHUSDT-1m-2024-05.zip', sha256: 'd512aa43b5b6a5168fa1b6242fe4cf01c88e51c78bb9f4d202f0ca2e42338f96' },
      { file: 'ETHUSDT-1m-2024-06.zip', sha256: '57e4b010904bbd754ee951ada7d9edd34bc4242379ae49fb66352e2c5f5cb525' },
      { file: 'ETHUSDT-1m-2024-07.zip', sha256: '34a3729eb2f6dd1563715e085eb936a4034357d95cba2605b96cf1cb5c533b65' },
      { file: 'ETHUSDT-1m-2024-08.zip', sha256: '2ccc1d0c491c63a6bfbabda39e8bd41e555a87052d77120199133e9e81bbf36c' },
      { file: 'ETHUSDT-1m-2024-09.zip', sha256: '317e18ce04f6312b4a3de3b5504bef2001a92bf72cb8e4988e160ee327c9c737' },
      { file: 'ETHUSDT-1m-2024-10.zip', sha256: 'd1f340994285a075a97d7d0ed5e9aca3d82dadbba8f817b2f886188420a009f1' },
      { file: 'ETHUSDT-1m-2024-11.zip', sha256: '4170f68dd576e8af35ecc9b19808dcb673c0423838bd560c7c4c1fabefdad5ad' },
      { file: 'ETHUSDT-1m-2024-12.zip', sha256: '82018947075e35e5ac0a771bb97a22118008db2c6fb6a94f8c1a2c4ebb34d12b' },
      { file: 'ETHUSDT-1m-2025-01.zip', sha256: '05e33ba3568c5381a36764097ea93917a7f1a93fadd1a0018e64bedb042526f6' },
      { file: 'ETHUSDT-1m-2025-02.zip', sha256: '79c07ecaaa04a04d815f428d0617b84cc536afe95f5cb2fc62bd93c10c3adfa1' },
      { file: 'ETHUSDT-1m-2025-03.zip', sha256: '82351bb41febb62d3680c761cf7cf9e29182435d9b4843e674ded63de3b29a32' },
      { file: 'ETHUSDT-1m-2025-04.zip', sha256: '75ea6a45c8bed04294449ff7d56f047c235a36fac176736816c01d6892bd8687' },
      { file: 'ETHUSDT-1m-2025-05.zip', sha256: 'a2560653e2f602444d2201e44e77cdba6e48233649d22fb7e8c703ce9fc6277a' },
      { file: 'ETHUSDT-1m-2025-06.zip', sha256: '189aa2e5daf3621f6f7f9fd58df763e0667592f3baf407270e0ad42399155c69' },
      { file: 'ETHUSDT-1m-2025-07.zip', sha256: 'e3af3ee3ac3251d313ad8987169d5c02bfd8c094bf047bbce9373eaf19ee479c' },
      { file: 'ETHUSDT-1m-2025-08.zip', sha256: '8cd85f1c417c4c65cd32348f3e4e23c8b35dd4e5e59a20a187e2a74777bd6664' },
      { file: 'ETHUSDT-1m-2025-09.zip', sha256: 'dc1f5e05a0b873accd0ed2a854ee14086da03b08a581198b20b5658042c6dc5f' },
      { file: 'ETHUSDT-1m-2025-10.zip', sha256: 'c0b8d557384ce1cd77df8f08cb6775f350a531a1792fa9deceb05f51a3939438' },
      { file: 'ETHUSDT-1m-2025-11.zip', sha256: '2dd6ded997100a92d11394eddccc54f1070b0fcf029c5e126859b5af80f6329e' },
      { file: 'ETHUSDT-1m-2025-12.zip', sha256: '8fc3e01faeb240ed9f77e4ba8bbcdf42bb7b0c7004d35fe8010bd0fd9090e4a9' },
      { file: 'ETHUSDT-1m-2026-01.zip', sha256: '0dc9c455c6d0735fe7e177d98a5088ab473c7fc1fa723710e783ff5dd49df4bb' },
      { file: 'ETHUSDT-1m-2026-02.zip', sha256: '2109cab7fa27eee904a7d6d6dd982633579fc4091765dc8fa16c001f2da8a1c2' },
      { file: 'ETHUSDT-1m-2026-03.zip', sha256: 'd61eeba7aed3067525c6503bfbfd4f8d55585b846b67115eb85eeb1d2f857bf1' },
      { file: 'ETHUSDT-1m-2026-04.zip', sha256: 'fd01f08f331a0dcb5d89c718afb199f7cda63f43228b72ddda0bdd08bfd527c7' },
      { file: 'ETHUSDT-1m-2026-05.zip', sha256: '9710b3d1e350bef5bf31b8d1531c5801d35f963d223d0a42e73ae86ddd376e92' },
      { file: 'ETHUSDT-1m-2026-06.zip', sha256: '3b771e114b494805ac4cc677b34befb7e5f332bf5bd3a8a368cd21d65cd99cba' },
      { file: 'ETHUSDT-1m-2026-07.zip', sha256: '5c98ad0cfa152fbe08df59838ead7c8bbfa433af943bbfb4d082626ebee2d83e' },
      { file: 'ETHUSDT-1m-2026-08.zip', sha256: '038b412935c3349e95b4abe3e9cec8a7fd521d16ce73fff3c2f92d605b252b9e' },
      { file: 'ETHUSDT-1m-2026-09.zip', sha256: 'c85c7ec631fa7fe3a90c30e4ef6a76aeac0b88be895872388d87a6a8fd3d2892' },
      { file: 'ETHUSDT-1m-2026-10.zip', sha256: 'ef0ecb89e153f59c5d862f7f8ec0fa802037eec037198246c4aac6a2c8617ada' },
      { file: 'SOLUSDT-1m-2024-01.zip', sha256: '7f24af8fea65040962f7fc73c8d61fb6128c583e9d6c555d6ccca96b4d50995a' },
      { file: 'SOLUSDT-1m-2024-02.zip', sha256: 'd5a3bd5540af9a97a6fa06e23154a78f88dd7eec2092d49b0cc284ae7c39fe16' },
      { file: 'SOLUSDT-1m-2024-03.zip', sha256: '78a1baab910e7cfcf53b3f2a4fe7519febbb6cc7407a353f95c83d07eaef1809' },
      { file: 'SOLUSDT-1m-2024-04.zip', sha256: 'e19eed213f5030153fd5e28c8b8cd14c8e05a93cfd5a28f15a68066e458dd414' },
      { file: 'SOLUSDT-1m-2024-05.zip', sha256: '3b62d6e6e687502f37c49eb635ca1dd2c5ac973c4bd3d820fe3700a126a46f98' },
      { file: 'SOLUSDT-1m-2024-06.zip', sha256: '55bee5af4510c5c05186cd62343895ce0dfcd5ed1b442b901c6cc5db300d0582' },
      { file: 'SOLUSDT-1m-2024-07.zip', sha256: '56f7b44a70d3a1eedeb43cde4e81a3deea6e1ff2406d332a9a8205082455758e' },
      { file: 'SOLUSDT-1m-2024-08.zip', sha256: '4ec6ef5fbd00a1e596324ea24909347abd6a623889089e9ef6e2f71625947eda' },
      { file: 'SOLUSDT-1m-2024-09.zip', sha256: '7c0b5f6a3c80684cbc733df88121ceefbb83645d9796db16107d1460e9a787c2' },
      { file: 'SOLUSDT-1m-2024-10.zip', sha256: 'f167b2be29ec4eef66fe38a17a6ade84034abf302c49deee31875a6f6cea6f53' },
      { file: 'SOLUSDT-1m-2024-11.zip', sha256: 'cc26ccf5eb442a5d66daa7396eb589d7c9934ba3301503a753c03ddbe94a4af0' },
      { file: 'SOLUSDT-1m-2024-12.zip', sha256: '631fd8d38ebc10376e985bc232f64a388a8ae50ffeb588098c4bcf39de45e05e' },
      { file: 'SOLUSDT-1m-2025-01.zip', sha256: 'b56b792f9fc9cd63dc0fef4841741692dc2e2cab3282faab66e9d0dc01ce58a1' },
      { file: 'SOLUSDT-1m-2025-02.zip', sha256: 'd513752226f0aef88958add63769a449ca835c5767a2f20c019eb1f8348da445' },
      { file: 'SOLUSDT-1m-2025-03.zip', sha256: '185a2ae8698968f90512a392eda65fdcc04163d7385eae0348387aedcb0763cb' },
      { file: 'SOLUSDT-1m-2025-04.zip', sha256: 'e946bbf26b8faf4b0be15d2f7763515d358a04062ddd662ff4a3c286740612b3' },
      { file: 'SOLUSDT-1m-2025-05.zip', sha256: '9e2baa8d15fed5768c72f1b97ad19b3119f87c90c8d9847ff3c628c2afb4d37c' },
      { file: 'SOLUSDT-1m-2025-06.zip', sha256: '32c17d28dbcfd8ccd5dce996f610f588ff6ec9e969c6eac9c9b43232a543f7aa' },
      { file: 'SOLUSDT-1m-2025-07.zip', sha256: '6a11ec2b081657fd4850b61cb1f28e2217913ac1a309c484169f080733320ee7' },
      { file: 'SOLUSDT-1m-2025-08.zip', sha256: '9916be68e1e354b1d2ad30e09ca2f0552ddbf9a3ad64d2854bd54016463b56a6' },
      { file: 'SOLUSDT-1m-2025-09.zip', sha256: '389290c0c468d168ea3b327d926e273aa9de639249e5101f443360eda4456b4e' },
      { file: 'SOLUSDT-1m-2025-10.zip', sha256: '66542f68d37e6b8b071997ea07fa495abc01d3762acbf6476398c63f79128016' },
      { file: 'SOLUSDT-1m-2025-11.zip', sha256: 'dbadf06d740261c21299abc82f3adeae1b41e4dbbcee8a5adca3e761f1896ce7' },
      { file: 'SOLUSDT-1m-2025-12.zip', sha256: 'c9375b066069aaa4dbf33fbf7c79ca9db4a534b99d4ebd9f558ba2381e610636' },
      { file: 'SOLUSDT-1m-2026-01.zip', sha256: 'ac9cc536ec056e7c4fc4f391da5edbe778f59fb2a059670875d05285ebca3fcf' },
      { file: 'SOLUSDT-1m-2026-02.zip', sha256: 'ad93c921265eb4a473ba91d21f8d02346d77330475740977cc7541a0ac1ec05a' },
      { file: 'SOLUSDT-1m-2026-03.zip', sha256: 'd705ca5ec2de775733be12c6e3f29bcf3204be15d7b0b273ec87a013fcaa612f' },
      { file: 'SOLUSDT-1m-2026-04.zip', sha256: '8ce6bb0ea598eecdfa2078cc1429c7fc4fc39a32d306d74184f137fa6ae8d3cb' },
      { file: 'SOLUSDT-1m-2026-05.zip', sha256: '588bdc611885c6de2bd55df7f8fbc597147ca0eef33f6824e340d2bff1a04066' },
      { file: 'SOLUSDT-1m-2026-06.zip', sha256: 'dcd12574ab820047a10c3e6977b69251b7285fe7998fa7aff6d73470c6637ecd' },
      { file: 'SOLUSDT-1m-2026-07.zip', sha256: '10b4d10f286b8cc658af3e441dbd0369b7b5e727626049cab59545f0c00062c0' },
      { file: 'SOLUSDT-1m-2026-08.zip', sha256: '0d895f66c4c07969845decf7d8e8752b0d8cb5409ca737b7b48c8751d4fd6f1f' },
      { file: 'SOLUSDT-1m-2026-09.zip', sha256: '58bcf27df2447043d9e955674de7c73bc42b848a7b8beb08d7800c9dd04813d1' },
      { file: 'SOLUSDT-1m-2026-10.zip', sha256: '9401a7a11659136b2cb631255de40953f28b6a3cb5591409bb5b2a9f5471d636' },
      { file: 'SUIUSDT-1m-2024-01.zip', sha256: '1d1ec8252bd17e5280e40ac385bb7197a67ae7cb4f5bec346dc1b7b421331427' },
      { file: 'SUIUSDT-1m-2024-02.zip', sha256: '4e5d4f247b0eb433c713ebaaeb8ea90ed91be966e8769b73dd1b3c7c088286ef' },
      { file: 'SUIUSDT-1m-2024-03.zip', sha256: '15880bf2f5fa18020e8fc8c0b4cef7d206fc93ae8eb83b71cbb3eca21c7a9d89' },
      { file: 'SUIUSDT-1m-2024-04.zip', sha256: 'fc2ea01a8baaa32662aa7e132a610eece78ebc1d9a75e7da52ad5fa2cae05114' },
      { file: 'SUIUSDT-1m-2024-05.zip', sha256: 'dde6e7ac6843dbe9cf9635f0dee90258b3390972596c07555425d769865f746d' },
      { file: 'SUIUSDT-1m-2024-06.zip', sha256: '5e8612a6b537c5e9286e7bf68af6ce2c015245964c9569aae3c0b7205c1e44d2' },
      { file: 'SUIUSDT-1m-2024-07.zip', sha256: 'f03bf1add35b5e1b0764b60308b2405b39a45aa5badd2d305e892774f4f052dd' },
      { file: 'SUIUSDT-1m-2024-08.zip', sha256: '334c1c762c4e91fe7293cbe27ac9c794658442705fcea572777a33db925fae90' },
      { file: 'SUIUSDT-1m-2024-09.zip', sha256: '1c9f7675ac8134b6a964c70bab1a1aeb195f56c5b4511fd6dd6231dbec985b72' },
      { file: 'SUIUSDT-1m-2024-10.zip', sha256: 'e44fe180c7818f646e35ba0dc5f51be278deabdf35391aed2919bfac6dc46bb5' },
      { file: 'SUIUSDT-1m-2024-11.zip', sha256: '7089040bd38d28664e861977278ea4785ea3a4987e9e5bcebfc573fd6999be19' },
      { file: 'SUIUSDT-1m-2024-12.zip', sha256: 'a1a2f06264f8df68fcd93c3bb8599155cc12f38862484e8006b598fe43b5f917' },
      { file: 'SUIUSDT-1m-2025-01.zip', sha256: '50db2e3534afb146636e37b5d0f21e48c25c84427f63482a2954c0723afa8dd9' },
      { file: 'SUIUSDT-1m-2025-02.zip', sha256: 'a0a5609980b72d4ba72b7032a2be5463e7c0c0ffaadec6b23bce49a529ad5e15' },
      { file: 'SUIUSDT-1m-2025-03.zip', sha256: 'a2d24c55aa82802f9f32e4c58faa86a611ddcf9a75671db4bf833b2299513520' },
      { file: 'SUIUSDT-1m-2025-04.zip', sha256: '03be26e11f13668e07a3f646adcce4f4219224cd8f442d6b2e7acd821132b41e' },
      { file: 'SUIUSDT-1m-2025-05.zip', sha256: '74bca49176a82bfcbd04d39bec2924acc8dce874e44389db68b9340be1116333' },
      { file: 'SUIUSDT-1m-2025-06.zip', sha256: 'a45dd7e1dac1f0c8e5e275ec2a42186bcfbc11691401e83c0d710863f14a97ac' },
      { file: 'SUIUSDT-1m-2025-07.zip', sha256: '8131b54dd189e6110f45b0f6d9949d614263a10f15b1fbd753057e8ca766c314' },
      { file: 'SUIUSDT-1m-2025-08.zip', sha256: '7f0d3026aa0988dac79ba4f6a25505be2de927bb5b2e1948f4e4f864cc8f60ee' },
      { file: 'SUIUSDT-1m-2025-09.zip', sha256: '9b386715abedd6c61bfdc82c0b6b55df536c31e1d47caacee3ad92768430dc49' },
      { file: 'SUIUSDT-1m-2025-10.zip', sha256: 'da9fe5c0213cc3176b2fdb521306b664badfa077eeb8dd8e307f8a98c03a29bc' },
      { file: 'SUIUSDT-1m-2025-11.zip', sha256: 'cd7976e2c26723c904d7a5c3db161b1f2eeb11e23b0609c0dac356d482a93cf3' },
      { file: 'SUIUSDT-1m-2025-12.zip', sha256: 'b4395eeb54424a99e62c328f6fff3bbb2e37768a7bc07c14bac0d49677a946bd' },
      { file: 'SUIUSDT-1m-2026-01.zip', sha256: '64f4dafceb5e7f20968f1a0abdb19c846a5fae087db0c1742bdce2961ccaf514' },
      { file: 'SUIUSDT-1m-2026-02.zip', sha256: 'd4868d031e2770a55d577fb90a4f4befe43f067dd6092b6eb8047093e67001fb' },
      { file: 'SUIUSDT-1m-2026-03.zip', sha256: 'ef501172acad09f20a8a7aa09f679460f104334e8abed0dbbbcc7e2fb75148b9' },
      { file: 'SUIUSDT-1m-2026-04.zip', sha256: '5ae72524816904eb52e7be8c0e1c86f452a067633796df3c479948ea30d12637' },
      { file: 'SUIUSDT-1m-2026-05.zip', sha256: '0fe939676edb224c9169981e625237e5675c7a409af1b0631a601c3160c7efc2' },
      { file: 'SUIUSDT-1m-2026-06.zip', sha256: '136329da3a797cc32024b7a0ed831c272e39ca29ee9b1fe81bdb76c7c370a181' },
      { file: 'SUIUSDT-1m-2026-07.zip', sha256: 'ac1f7ceac03cb039233a91712d80276336e7d786276e69df49aee89b0e81f355' },
      { file: 'SUIUSDT-1m-2026-08.zip', sha256: 'fe8a4da680892fa7a4c0a997407d7cbe04452b2a02b099ed203b4e2ab1f66b7a' },
      { file: 'SUIUSDT-1m-2026-09.zip', sha256: '9f0220be8a9fc8e9e3e83ac50f9ccfc9acfd743ecd81586a8ce1fa311c0d8ea4' },
      { file: 'SUIUSDT-1m-2026-10.zip', sha256: 'baf1de02a078ae302dae5b4c99562d903ebe23630bbeb76f0d206d4d4995afa4' },
      { file: 'XRPUSDT-1m-2024-01.zip', sha256: '9d0623c5b5d6e13e8dc5698383b317af8f46a3fe9d587fc9d01236a309f7993f' },
      { file: 'XRPUSDT-1m-2024-02.zip', sha256: '90242d3140d75918c3be287907f805fe10c44c40b27cd16689a5716d6afac022' },
      { file: 'XRPUSDT-1m-2024-03.zip', sha256: '01fa94527d6b7af23ab08bb72e1d11f6e4a6b822f4291fdd14fb292128eddada' },
      { file: 'XRPUSDT-1m-2024-04.zip', sha256: 'c545585efc5dc8896c68ff4982e33f106122e2479a265c92c1a85eb64abbc4bc' },
      { file: 'XRPUSDT-1m-2024-05.zip', sha256: 'ea69a39f55006d3256522737ae2596f189bc312d0b650f84bd88feb5249622e2' },
      { file: 'XRPUSDT-1m-2024-06.zip', sha256: '6037c88969245bc20fdd61161976d16788b8760c51314cc750b8fe8c26bdf55e' },
      { file: 'XRPUSDT-1m-2024-07.zip', sha256: 'fa9522c88de7568fc2ca39dac841800fb7fd5b0d077a49c9db103483bdab7318' },
      { file: 'XRPUSDT-1m-2024-08.zip', sha256: 'faaf73419f5fa99b3f1aae6bfe0bbf43fa8e18caeeb87a5cacf0b451d74e3415' },
      { file: 'XRPUSDT-1m-2024-09.zip', sha256: 'fb4f51b21645be9705942ed7bfb69a01c16b5cc98590b52ffd8a2f71142e4225' },
      { file: 'XRPUSDT-1m-2024-10.zip', sha256: '5a739dc9a458fef0e5aecfb457e3523686d451e598ead2df86adbb65b4144dd9' },
      { file: 'XRPUSDT-1m-2024-11.zip', sha256: 'f2177e1c6e95f5dff765dc5643abdcd6a151795947e69ea85b7eb7211ab926bd' },
      { file: 'XRPUSDT-1m-2024-12.zip', sha256: '659add47d41b25189bfed69ae3052253df648443e2aa0376537ccece6a39d6ee' },
      { file: 'XRPUSDT-1m-2025-01.zip', sha256: '79f499a9a556b712ea1c28bc83c5e8294160cc4b87561424db1d108f5e87661b' },
      { file: 'XRPUSDT-1m-2025-02.zip', sha256: '6d75a5c0205f1cdee2dea2b616c04e3a7e88176126723237c1a5859843eb0fa0' },
      { file: 'XRPUSDT-1m-2025-03.zip', sha256: '5354c5b2168ba9ebce28fee3c45a65ad4d3722c3cede41c53aef164bd68d119b' },
      { file: 'XRPUSDT-1m-2025-04.zip', sha256: '5223fbd5576882ca2371fe4ffb0224674967cedf1427b82635cc9d01a6a232ab' },
      { file: 'XRPUSDT-1m-2025-05.zip', sha256: 'bc4eb9aed40935c8a21485218037f5de9c1919bea5524f9f4eb6e82efbd7bcee' },
      { file: 'XRPUSDT-1m-2025-06.zip', sha256: '1aba24ca083027da84fabf5dce0a624d47fee0c36501ad5641b6a65e040b294e' },
      { file: 'XRPUSDT-1m-2025-07.zip', sha256: '6f5f7faa96370dacb4792b18ce628d3ff8b0a5fa4cd10063e55065e03ff9f53d' },
      { file: 'XRPUSDT-1m-2025-08.zip', sha256: '823e87bba1c53bebffd8074ee190adfae55c489936ff5d539fcdf54e1ea68633' },
      { file: 'XRPUSDT-1m-2025-09.zip', sha256: '0f47e24c9e133c09d0df6756e224c2547d5e1ca3c9ba7af77232d1e9368330fb' },
      { file: 'XRPUSDT-1m-2025-10.zip', sha256: '9ba37c1fb1bded7e554dbfc9221c126cdb8bf4c569b4b5c639e83bcda38b6b3e' },
      { file: 'XRPUSDT-1m-2025-11.zip', sha256: 'dd62352ab1fc3b2e8f5f235c7c775044432a493c8a5ab732f709acfe1c8f62bc' },
      { file: 'XRPUSDT-1m-2025-12.zip', sha256: '821efe300f5a66a68fe468e45fe9094431fac70b62a909c4aa7cc97239c4ce4c' },
      { file: 'XRPUSDT-1m-2026-01.zip', sha256: '8612f9c3796982d55feb1696d4a08407e4910d40cfce25e71b0172dea32b9847' },
      { file: 'XRPUSDT-1m-2026-02.zip', sha256: '58bff9b0136a1584414b6d24133279c02a56030da7625942c286e9d11f3d37a3' },
      { file: 'XRPUSDT-1m-2026-03.zip', sha256: '38b4f4f23cd92c23b37c2fea4e827540af06c8a0e2330bff8491acaf3d14e794' },
      { file: 'XRPUSDT-1m-2026-04.zip', sha256: 'e887d411a37786bfd83d3fcbe7561801529d3c9e012d90b420c628226253d63a' },
      { file: 'XRPUSDT-1m-2026-05.zip', sha256: '6733b41f25b4a278a67ae6002e5f20c089a61ae864d99c9d1b002e375c932f9b' },
      { file: 'XRPUSDT-1m-2026-06.zip', sha256: 'b49faed75492e1136f2dc3f8cad1328e55c3179368ba80b85e1f961d536a8a47' },
      { file: 'XRPUSDT-1m-2026-07.zip', sha256: '0cb5c416531326d23013fb5f38dc8fd9b83f60768d349ae4dacae69da0e4403a' },
      { file: 'XRPUSDT-1m-2026-08.zip', sha256: 'e4108def774c3daf34c1639d0a0a0ad5a4addc35df4cf927b493fc887c242854' },
      { file: 'XRPUSDT-1m-2026-09.zip', sha256: 'a28a4de41559ead96b00db22ab4fa6aecbffd48331b7e876386b99da04861e48' },
      { file: 'XRPUSDT-1m-2026-10.zip', sha256: '5d54d8493ae94343b6b28ae4d5e65c38ce72715a48cf3d1735d7f66914e91dfb' },
    ],
    dataRange: { start: '2024-01-01T00:00Z', end: '2026-10-31T23:59Z' },
    fitWindow: { start: '2024-01-01T00:00Z', end: '2025-12-31T23:59Z' },
    holdoutWindow: { start: '2026-01-01T00:00Z', end: '2026-10-31T23:59Z' },
    coins: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'SUI', '1000PEPE'],
    maintenanceRates: { BTC: 0.0033, ETH: 0.0033, SOL: 0.005, XRP: 0.005, DOGE: 0.0075, BNB: 0.0067, SUI: 0.009, '1000PEPE': 0.01 },
    seed: 20261105,
    entriesPerCoinPerCell: 5000,
    sigmaBars1h: 168,
    atrPeriod: 14,
    recalBins: 20,
    reliabilityBins: 10,
    passRule: 'recalibrated ECE <= 2.000 pp pooled over the field\'s cells; every reliability bin with n >= 1000 within +-5.000 pp; recalibrated Brier <= climatology in every cell at 3 dp (equal counts)',
  },
};
