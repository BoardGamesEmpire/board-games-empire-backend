/**
 * Declaring `setupFiles` in this project's jest config overrides the
 * preset's `reflect-metadata` entry (see the note in jest.preset.js), so it
 * must be loaded here — decorator metadata is evaluated the moment the
 * first Nest/DTO module is imported.
 */
import 'reflect-metadata';
