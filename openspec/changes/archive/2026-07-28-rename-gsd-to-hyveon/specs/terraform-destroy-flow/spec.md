## MODIFIED Requirements

### Requirement: Preload destroy bridge

The preload SHALL expose the destroy surface on the `hyveon.terraform` namespace — a token-minting call plus a `destroy` call following the existing streaming bridge shape (side-channel chunk/end events surfaced to the renderer, honoring the test-mode mock registry) — with typed mirrors in `hyveon-api.ts` kept in sync with the controller payload shapes.

#### Scenario: Renderer consumes destroy output through the bridge

- **WHEN** the renderer initiates a destroy through `hyveon.terraform` with a freshly minted token
- **THEN** it receives the run's chunks in order and a terminal completion/error through the preload bridge without touching `ipcRenderer` directly
