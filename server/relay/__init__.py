"""Chocco relay package — lobby, rooms and lockstep tick coordination.

Pure relay for deterministic lockstep: the simulation runs client-side; this
package only coordinates rooms, hands out the shared match seed, and relays
per-tick inputs (see shared/protocol.ts for the authoritative wire protocol).
"""
