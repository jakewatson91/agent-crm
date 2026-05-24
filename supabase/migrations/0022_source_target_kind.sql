-- Extend target_kind enum so events.action='update_source' can record
-- source mutations under their own target_kind. Used by the L2 source
-- curator (decide-and-notify path) so undo can reliably find prior state
-- via events.target_kind='source' AND events.target_id=<source_id>.
alter type target_kind add value if not exists 'source';
