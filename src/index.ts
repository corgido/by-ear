// SPDX-License-Identifier: MIT
// Copyright (c) 2026 corgido
//
// by-ear: a race car's telemetry from its sound. Start with Listener (src/listen.ts); the parts are exported for anyone
// building on them.
export { Listener, CSV_HEADER, csvRow, type Row, type ListenerOptions } from './listen';
export { EngineAnalyser, type EngineFrame, type EngineOutput, type ShiftEvent, type LimiterHit } from './engine';
export { CARS, carById, speedKmh, type CarProfile } from './cars';
export { buildReport, type Report } from './report';
export { Dash, type DashGear } from './dash';
export { carMismatch, carSuggest } from './mismatch';
export { OnboardSynth, simulateOnboard, truthAt, type OnboardOptions } from './generator';
export { readWav } from './wav';
export type { TrackDef } from './track';
