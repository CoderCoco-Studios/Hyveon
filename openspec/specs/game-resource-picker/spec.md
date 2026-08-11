# game-resource-picker Specification

## Purpose
TBD - created by archiving change game-server-resource-sliders. Update Purpose to describe the actual capability.

## Requirements
### Requirement: vCPU and memory selected via constrained sliders
The add-game wizard's and edit-game form's Resources step SHALL present
vCPU and memory selection as two slider controls rather than dropdown
lists. Both sliders SHALL only be able to reach values corresponding to a
valid AWS Fargate (vCPU, memory) pair — the operator SHALL NOT be able to
select or land on an invalid combination through slider interaction alone.

#### Scenario: vCPU slider only exposes real Fargate tiers
- **WHEN** an operator drags the vCPU slider across its full range
- **THEN** it stops only at the 7 valid Fargate vCPU tiers (0.25, 0.5, 1,
  2, 4, 8, 16 vCPU) and never at an intermediate value

#### Scenario: Memory slider range depends on the selected vCPU tier
- **WHEN** an operator selects a vCPU tier
- **THEN** the memory slider's reachable values are exactly the valid
  memory options for that vCPU tier, including tiers whose valid memory
  values are not evenly spaced by a single step (e.g. the 0.25 vCPU tier's
  512/1024/2048 MiB options) and tiers whose step size differs from 1 GiB
  (e.g. 4 GiB steps at 8 vCPU, 8 GiB steps at 16 vCPU)

#### Scenario: Changing vCPU re-ranges an already-selected memory value
- **WHEN** an operator has selected a memory value and then changes the
  vCPU slider such that the current memory value is no longer valid for
  the newly selected vCPU tier
- **THEN** the memory slider's value is reset to unset (not automatically
  re-clamped to another valid value) — the operator must pick memory again
  for the newly selected vCPU tier

### Requirement: Resource selection applies to both add and edit flows
The slider-based Resources step SHALL be used both when creating a new
game server in the add-game wizard and when editing an existing game
server's resources in the edit-game form, via the same underlying
component.

#### Scenario: Add-game wizard uses sliders
- **WHEN** an operator reaches the Resources step of the add-game wizard
- **THEN** vCPU and memory are selected via sliders, not dropdowns

#### Scenario: Edit-game form uses sliders
- **WHEN** an operator opens the edit-game form for an existing game
  server
- **THEN** vCPU and memory are selected via the same slider controls as
  the add-game wizard, pre-populated with the game server's current
  values
