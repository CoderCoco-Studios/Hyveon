## ADDED Requirements

### Requirement: Responsive wizard shell layout

The first-run wizard SHALL render a two-region layout at the `md:`
breakpoint (768px) and above: a fixed-width step-progress sidebar alongside
the active step's content, with the content column's maximum width
increased from 576px to 672px. Below the `md:` breakpoint, the wizard SHALL
render as a single centered column matching its current (pre-change)
layout, with the sidebar not shown.

#### Scenario: Wide viewport shows sidebar and wider content

- **WHEN** the wizard renders in a window at least 768px wide
- **THEN** a step-progress sidebar is visible alongside the step content,
  and the step content's container is wider than the pre-change 576px cap

#### Scenario: Narrow viewport falls back to single column

- **WHEN** the wizard renders in a window narrower than 768px
- **THEN** no step-progress sidebar is shown and the step content renders
  as a single centered column at its original width

### Requirement: Step progress sidebar

When shown, the step-progress sidebar SHALL list all wizard steps in order
and indicate, per step, whether it is completed (before the current step),
current, or upcoming (after the current step). The sidebar SHALL NOT be
interactive — it MUST NOT provide a way to navigate directly to a step
other than through the wizard's existing forward/back controls.

#### Scenario: Sidebar reflects current step position

- **WHEN** the wizard is showing step 3 of 5
- **THEN** the sidebar shows steps 1-2 as completed, step 3 as current, and
  steps 4-5 as upcoming

#### Scenario: Sidebar entries do not navigate

- **WHEN** the operator interacts with a step-progress sidebar entry for a
  step other than the current one
- **THEN** the wizard's current step does not change
