# Derived implementations

A Rust trait and its derive macro can share a name while coming from separate crates or features. Inspect the actual imports and manifests. For example, a workspace test can import traits from serde and derive macros from serde_derive; use the package's declared test dependencies and helpers.

Generated behavior can depend on identifier spelling. Renaming a derived type can change a serialized struct name, while a token/string expectation remains unchanged by semantic rename. Check format, schema or token assertions alongside compilation. Update expectations deliberately according to the requested behavior; record those changes separately from LSP-provided edits.

Run checks against the edited files. If a temporary program is recreated after failure, preserve or reapply the intended change before counting its runtime result. A test of the original source does not verify the rename.
