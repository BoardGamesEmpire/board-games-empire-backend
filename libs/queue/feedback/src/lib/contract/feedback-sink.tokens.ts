/**
 * Every {@link FeedbackSink} registered with the runtime. `FeedbackSinkRegistry`
 * indexes these by `slug` and routes each delivery job to the sink recorded on
 * its `FeedbackSubmission.sinkSlug`. An unregistered slug is a loud failure,
 * never a wrong-sink delivery — mirrors `STORAGE_DRIVERS` (#100).
 *
 * Providers aggregate concrete sinks into this token via `useFactory`; new sinks
 * (plugin sinks, once #59 lands) register here as they arrive.
 */
export const FEEDBACK_SINKS = Symbol('FEEDBACK_SINKS');
