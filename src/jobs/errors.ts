/** An unknown state name, or an empty `from` list, handed to the store (programming error). Never touches the database. */
export class InvalidTransitionError extends Error {
  constructor(
    readonly from: readonly string[],
    readonly to: string,
  ) {
    super(`Transition to '${to}' is not allowed from: ${from.length > 0 ? from.join(', ') : '(nothing)'}`);
    this.name = 'InvalidTransitionError';
  }
}

/** Arguments handed to the store are structurally wrong (programming error). Lists field names, never values. */
export class InvalidJobInputError extends Error {
  constructor(
    readonly fields: readonly string[],
    context: string,
  ) {
    super(`Invalid job store input (${context}): ${fields.join(', ')}`);
    this.name = 'InvalidJobInputError';
  }
}

/** A value read from the database failed validation. Carries the row id and field names only, never values. */
export class CorruptJobStoreError extends Error {
  constructor(
    readonly where: string,
    readonly fields: readonly string[],
  ) {
    super(`Job store data is corrupted (${where}): invalid ${fields.join(', ')}`);
    this.name = 'CorruptJobStoreError';
  }
}

/** The database file was written by a different (newer or inconsistent) schema than this code knows. */
export class JobStoreSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobStoreSchemaError';
  }
}
