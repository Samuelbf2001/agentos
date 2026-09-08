ALTER TABLE `org_roles` ADD `agent_id` text REFERENCES agents(id);
