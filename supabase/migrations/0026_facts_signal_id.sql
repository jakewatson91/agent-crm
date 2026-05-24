-- Cite chain fix: bind each fact directly to the signal that triggered its
-- first assertion. Replaces the parent_event_id walk in the chain route,
-- which was producing wrong attributions when a fact was later re-asserted
-- via a different signal (last-walked-event wins).
--
-- Nullable: legacy facts and facts asserted outside an enricher path stay
-- null. The chain walker falls back to the parent-event walk for those.
--
-- Supersede semantics (enforced in app code, not here): when a fact is
-- superseded by a re-assertion, the new fact takes the *new* signal_id if
-- one is passed; otherwise it inherits the prior fact's signal_id. The
-- column is otherwise immutable.

alter table facts add column signal_id uuid references signals(id) on delete set null;

create index facts_signal_id_idx on facts(signal_id) where signal_id is not null;
