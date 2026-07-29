-- FSOC Workboard schema.
--
-- The Go server built this through 129 sequential migrations. This Node server
-- has no migration runner, so a fresh database is created from here instead.
-- Generated from a database those migrations had already brought up to date.
--
-- Safe to re-run: every CREATE uses IF NOT EXISTS and the migration rows use
-- INSERT IGNORE, so applying it to an existing database changes nothing.
--
-- Apply with:  npm run db:init
--
-- Collations are utf8mb4_unicode_ci rather than the utf8mb4_uca1400_ai_ci a
-- recent MariaDB emits, because the latter does not exist on older MySQL.

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS `api_tokens` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `token_salt` varchar(255) NOT NULL,
  `token_hash` varchar(255) NOT NULL,
  `token_last_eight` varchar(8) NOT NULL,
  `permissions` text NOT NULL,
  `expires_at` datetime NOT NULL,
  `created` datetime NOT NULL,
  `owner_id` bigint(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_api_tokens_id` (`id`),
  UNIQUE KEY `UQE_api_tokens_token_hash` (`token_hash`),
  KEY `IDX_api_tokens_token_last_eight` (`token_last_eight`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `buckets` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `title` text NOT NULL,
  `project_view_id` bigint(20) NOT NULL,
  `limit` bigint(20) DEFAULT 0,
  `position` double DEFAULT NULL,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  `created_by_id` bigint(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_buckets_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `favorites` (
  `entity_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `kind` int(11) NOT NULL,
  PRIMARY KEY (`entity_id`,`user_id`,`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `files` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `name` text NOT NULL,
  `mime` text DEFAULT NULL,
  `size` bigint(20) NOT NULL,
  `created` datetime DEFAULT NULL,
  `created_by_id` bigint(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_files_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `label_tasks` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `task_id` bigint(20) NOT NULL,
  `label_id` bigint(20) NOT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_label_tasks_id` (`id`),
  KEY `IDX_label_tasks_label_id` (`label_id`),
  KEY `IDX_label_tasks_task_id` (`task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `labels` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `title` varchar(250) NOT NULL,
  `description` longtext DEFAULT NULL,
  `hex_color` varchar(6) DEFAULT NULL,
  `created_by_id` bigint(20) NOT NULL,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_labels_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `license_status` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `instance_id` varchar(36) NOT NULL,
  `response` text NOT NULL,
  `validated_at` datetime DEFAULT NULL,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_license_status_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `link_shares` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `hash` varchar(40) NOT NULL,
  `name` text DEFAULT NULL,
  `project_id` bigint(20) NOT NULL,
  `permission` bigint(20) NOT NULL DEFAULT 0,
  `sharing_type` bigint(20) NOT NULL DEFAULT 0,
  `password` text DEFAULT NULL,
  `shared_by_id` bigint(20) NOT NULL,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_link_shares_id` (`id`),
  UNIQUE KEY `UQE_link_shares_hash` (`hash`),
  KEY `IDX_link_shares_permission` (`permission`),
  KEY `IDX_link_shares_sharing_type` (`sharing_type`),
  KEY `IDX_link_shares_shared_by_id` (`shared_by_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `migration` (
  `id` varchar(255) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `migration_status` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) NOT NULL,
  `migrator_name` varchar(255) DEFAULT NULL,
  `started_at` datetime NOT NULL,
  `finished_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_migration_status_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `notifications` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `notifiable_id` bigint(20) NOT NULL,
  `notification` text NOT NULL,
  `name` varchar(250) NOT NULL,
  `subject_id` bigint(20) DEFAULT NULL,
  `read_at` datetime DEFAULT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_notifications_id` (`id`),
  KEY `IDX_notifications_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `oauth_codes` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) NOT NULL,
  `code` varchar(128) NOT NULL,
  `expires_at` datetime NOT NULL,
  `client_id` varchar(255) NOT NULL,
  `redirect_uri` text NOT NULL,
  `code_challenge` varchar(128) NOT NULL,
  `code_challenge_method` varchar(10) NOT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_oauth_codes_id` (`id`),
  UNIQUE KEY `UQE_oauth_codes_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `project_views` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `project_id` bigint(20) NOT NULL,
  `view_kind` int(11) NOT NULL,
  `filter` text DEFAULT NULL,
  `position` double DEFAULT NULL,
  `bucket_configuration_mode` int(11) DEFAULT 0,
  `bucket_configuration` text DEFAULT NULL,
  `default_bucket_id` bigint(20) DEFAULT NULL,
  `done_bucket_id` bigint(20) DEFAULT NULL,
  `updated` datetime NOT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_project_views_id` (`id`),
  KEY `IDX_project_views_done_bucket_id` (`done_bucket_id`),
  KEY `IDX_project_views_project_id` (`project_id`),
  KEY `IDX_project_views_default_bucket_id` (`default_bucket_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `projects` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `title` varchar(250) NOT NULL,
  `description` longtext DEFAULT NULL,
  `identifier` varchar(10) DEFAULT NULL,
  `hex_color` varchar(6) DEFAULT NULL,
  `owner_id` bigint(20) NOT NULL,
  `parent_project_id` bigint(20) DEFAULT NULL,
  `is_archived` tinyint(1) NOT NULL DEFAULT 0,
  `background_file_id` bigint(20) DEFAULT NULL,
  `background_blur_hash` varchar(50) DEFAULT NULL,
  `position` double DEFAULT NULL,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_projects_id` (`id`),
  KEY `IDX_projects_owner_id` (`owner_id`),
  KEY `IDX_projects_parent_project_id` (`parent_project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `reactions` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) NOT NULL,
  `entity_id` bigint(20) NOT NULL,
  `entity_kind` bigint(20) NOT NULL,
  `value` varchar(20) NOT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_reactions_id` (`id`),
  KEY `IDX_reactions_user_id` (`user_id`),
  KEY `IDX_reactions_entity_id` (`entity_id`),
  KEY `IDX_reactions_entity_kind` (`entity_kind`),
  KEY `IDX_reactions_value` (`value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `saved_filters` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `filters` text NOT NULL,
  `title` varchar(250) NOT NULL,
  `description` longtext DEFAULT NULL,
  `owner_id` bigint(20) NOT NULL,
  `is_favorite` tinyint(1) DEFAULT 0,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_saved_filters_id` (`id`),
  KEY `IDX_saved_filters_owner_id` (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `sessions` (
  `id` varchar(36) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `token_hash` varchar(64) NOT NULL,
  `device_info` text DEFAULT NULL,
  `ip_address` varchar(100) DEFAULT NULL,
  `is_long_session` tinyint(1) NOT NULL DEFAULT 0,
  `oidcid_token` text DEFAULT NULL,
  `oidc_provider_key` varchar(250) DEFAULT NULL,
  `last_active` datetime NOT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_sessions_id` (`id`),
  UNIQUE KEY `UQE_sessions_token_hash` (`token_hash`),
  KEY `IDX_sessions_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `storage_items` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `project_id` bigint(20) NOT NULL,
  `title` varchar(250) NOT NULL,
  `kind` int(11) NOT NULL,
  `url` text DEFAULT NULL,
  `file_id` bigint(20) DEFAULT NULL,
  `created_by_id` bigint(20) NOT NULL,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_storage_items_id` (`id`),
  KEY `IDX_storage_items_project_id` (`project_id`),
  KEY `IDX_storage_items_kind` (`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `subscriptions` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `entity_type` int(11) NOT NULL,
  `entity_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_subscriptions_id` (`id`),
  KEY `IDX_subscriptions_entity_type` (`entity_type`),
  KEY `IDX_subscriptions_entity_id` (`entity_id`),
  KEY `IDX_subscriptions_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `task_assignees` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `task_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_task_assignees_id` (`id`),
  KEY `IDX_task_assignees_task_id` (`task_id`),
  KEY `IDX_task_assignees_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `task_attachments` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `task_id` bigint(20) NOT NULL,
  `file_id` bigint(20) NOT NULL,
  `created_by_id` bigint(20) NOT NULL,
  `created` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_task_attachments_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `task_buckets` (
  `bucket_id` bigint(20) NOT NULL,
  `task_id` bigint(20) NOT NULL,
  `project_view_id` bigint(20) NOT NULL,
  UNIQUE KEY `UQE_task_buckets_task_view` (`task_id`,`project_view_id`),
  KEY `IDX_task_buckets_task_id` (`task_id`),
  KEY `IDX_task_buckets_project_view_id` (`project_view_id`),
  KEY `IDX_task_buckets_bucket_id` (`bucket_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `task_comments` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `comment` text NOT NULL,
  `author_id` bigint(20) NOT NULL,
  `task_id` bigint(20) NOT NULL,
  `created` datetime DEFAULT NULL,
  `updated` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_task_comments_id` (`id`),
  KEY `IDX_task_comments_task_id` (`task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `task_positions` (
  `task_id` bigint(20) NOT NULL,
  `project_view_id` bigint(20) NOT NULL,
  `position` double NOT NULL,
  UNIQUE KEY `UQE_task_positions_task_view` (`task_id`,`project_view_id`),
  KEY `IDX_task_positions_project_view_id` (`project_view_id`),
  KEY `IDX_task_positions_task_id` (`task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `task_relations` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `task_id` bigint(20) NOT NULL,
  `other_task_id` bigint(20) NOT NULL,
  `relation_kind` varchar(50) NOT NULL,
  `created_by_id` bigint(20) NOT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_task_relations_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `task_reminders` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `task_id` bigint(20) NOT NULL,
  `reminder` datetime NOT NULL,
  `created` datetime NOT NULL,
  `relative_period` bigint(20) DEFAULT NULL,
  `relative_to` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_task_reminders_id` (`id`),
  KEY `IDX_task_reminders_task_id` (`task_id`),
  KEY `IDX_task_reminders_reminder` (`reminder`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `task_unread_statuses` (
  `task_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  UNIQUE KEY `UQE_task_unread_statuses_task_user` (`task_id`,`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `tasks` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `title` text NOT NULL,
  `description` longtext DEFAULT NULL,
  `done` tinyint(1) DEFAULT NULL,
  `done_at` datetime DEFAULT NULL,
  `due_date` datetime DEFAULT NULL,
  `project_id` bigint(20) NOT NULL,
  `repeat_after` bigint(20) DEFAULT NULL,
  `repeat_mode` int(11) NOT NULL DEFAULT 0,
  `priority` bigint(20) DEFAULT NULL,
  `start_date` datetime DEFAULT NULL,
  `end_date` datetime DEFAULT NULL,
  `hex_color` varchar(6) DEFAULT NULL,
  `percent_done` double DEFAULT NULL,
  `index` bigint(20) NOT NULL DEFAULT 0,
  `uid` varchar(250) DEFAULT NULL,
  `cover_image_attachment_id` bigint(20) DEFAULT 0,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  `deleted_at` datetime DEFAULT NULL,
  `created_by_id` bigint(20) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_tasks_tasks_project_index` (`project_id`,`index`),
  UNIQUE KEY `UQE_tasks_id` (`id`),
  KEY `IDX_tasks_done` (`done`),
  KEY `IDX_tasks_done_at` (`done_at`),
  KEY `IDX_tasks_project_id` (`project_id`),
  KEY `IDX_tasks_repeat_after` (`repeat_after`),
  KEY `IDX_tasks_start_date` (`start_date`),
  KEY `IDX_tasks_end_date` (`end_date`),
  KEY `IDX_tasks_due_date` (`due_date`),
  KEY `IDX_tasks_deleted_at` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `team_members` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `team_id` bigint(20) NOT NULL,
  `user_id` bigint(20) NOT NULL,
  `admin` tinyint(1) DEFAULT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_team_members_id` (`id`),
  KEY `IDX_team_members_team_id` (`team_id`),
  KEY `IDX_team_members_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `team_projects` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `team_id` bigint(20) NOT NULL,
  `project_id` bigint(20) NOT NULL,
  `permission` bigint(20) NOT NULL DEFAULT 0,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_team_projects_id` (`id`),
  KEY `IDX_team_projects_team_id` (`team_id`),
  KEY `IDX_team_projects_project_id` (`project_id`),
  KEY `IDX_team_projects_permission` (`permission`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `teams` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `description` longtext DEFAULT NULL,
  `created_by_id` bigint(20) NOT NULL,
  `external_id` varchar(250) DEFAULT NULL,
  `issuer` text DEFAULT NULL,
  `created` datetime DEFAULT NULL,
  `updated` datetime DEFAULT NULL,
  `is_public` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_teams_id` (`id`),
  KEY `IDX_teams_created_by_id` (`created_by_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `time_entries` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) NOT NULL,
  `task_id` bigint(20) DEFAULT NULL,
  `project_id` bigint(20) DEFAULT NULL,
  `start_time` datetime NOT NULL,
  `end_time` datetime DEFAULT NULL,
  `comment` text DEFAULT NULL,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_time_entries_id` (`id`),
  KEY `IDX_time_entries_start_time` (`start_time`),
  KEY `IDX_time_entries_user_id` (`user_id`),
  KEY `IDX_time_entries_task_id` (`task_id`),
  KEY `IDX_time_entries_project_id` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `totp` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) NOT NULL,
  `secret` text NOT NULL,
  `enabled` tinyint(1) DEFAULT NULL,
  `url` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_totp_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `unsplash_photos` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `file_id` bigint(20) NOT NULL,
  `unsplash_id` varchar(50) DEFAULT NULL,
  `author` text DEFAULT NULL,
  `author_name` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_unsplash_photos_id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `user_tokens` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) NOT NULL,
  `token` varchar(450) NOT NULL,
  `kind` int(11) NOT NULL,
  `created` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_user_tokens_id` (`id`),
  KEY `IDX_user_tokens_token` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `users` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `name` text DEFAULT NULL,
  `username` varchar(250) NOT NULL,
  `password` varchar(250) DEFAULT NULL,
  `email` varchar(250) DEFAULT NULL,
  `status` int(11) DEFAULT 0,
  `is_admin` tinyint(1) NOT NULL DEFAULT 0,
  `avatar_provider` varchar(255) DEFAULT NULL,
  `avatar_file_id` bigint(20) DEFAULT NULL,
  `issuer` text DEFAULT NULL,
  `subject` text DEFAULT NULL,
  `email_reminders_enabled` tinyint(1) DEFAULT 1,
  `discoverable_by_name` tinyint(1) DEFAULT 0,
  `discoverable_by_email` tinyint(1) DEFAULT 0,
  `overdue_tasks_reminders_enabled` tinyint(1) DEFAULT 1,
  `overdue_tasks_reminders_time` varchar(5) NOT NULL DEFAULT '09:00',
  `default_project_id` bigint(20) DEFAULT NULL,
  `bot_owner_id` bigint(20) DEFAULT NULL,
  `week_start` int(11) DEFAULT NULL,
  `language` varchar(50) DEFAULT NULL,
  `timezone` varchar(255) DEFAULT NULL,
  `deletion_scheduled_at` datetime DEFAULT NULL,
  `deletion_last_reminder_sent` datetime DEFAULT NULL,
  `frontend_settings` text DEFAULT NULL,
  `extra_settings_links` text DEFAULT NULL,
  `export_file_id` bigint(20) DEFAULT NULL,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_users_id` (`id`),
  UNIQUE KEY `UQE_users_username` (`username`),
  KEY `IDX_users_discoverable_by_name` (`discoverable_by_name`),
  KEY `IDX_users_discoverable_by_email` (`discoverable_by_email`),
  KEY `IDX_users_overdue_tasks_reminders_enabled` (`overdue_tasks_reminders_enabled`),
  KEY `IDX_users_default_project_id` (`default_project_id`),
  KEY `IDX_users_bot_owner_id` (`bot_owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `users_projects` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) NOT NULL,
  `project_id` bigint(20) NOT NULL,
  `permission` bigint(20) NOT NULL DEFAULT 0,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_users_projects_id` (`id`),
  KEY `IDX_users_projects_project_id` (`project_id`),
  KEY `IDX_users_projects_permission` (`permission`),
  KEY `IDX_users_projects_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `webhooks` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `target_url` varchar(255) NOT NULL,
  `events` text NOT NULL,
  `project_id` bigint(20) DEFAULT NULL,
  `user_id` bigint(20) DEFAULT NULL,
  `secret` varchar(255) DEFAULT NULL,
  `basic_auth_user` varchar(255) DEFAULT NULL,
  `basic_auth_password` varchar(255) DEFAULT NULL,
  `created_by_id` bigint(20) NOT NULL,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQE_webhooks_id` (`id`),
  KEY `IDX_webhooks_project_id` (`project_id`),
  KEY `IDX_webhooks_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Records which migrations the schema already reflects, so the Go server would
-- not try to replay them if it were ever pointed at this database.
INSERT IGNORE INTO `migration` VALUES ('SCHEMA_INIT','');
INSERT IGNORE INTO `migration` VALUES ('20190324205606','');
INSERT IGNORE INTO `migration` VALUES ('20190328074430','');
INSERT IGNORE INTO `migration` VALUES ('20190430111111','');
INSERT IGNORE INTO `migration` VALUES ('20190511202210','');
INSERT IGNORE INTO `migration` VALUES ('20190514192749','');
INSERT IGNORE INTO `migration` VALUES ('20190524205441','');
INSERT IGNORE INTO `migration` VALUES ('20190718200716','');
INSERT IGNORE INTO `migration` VALUES ('20190818210133','');
INSERT IGNORE INTO `migration` VALUES ('20190920185205','');
INSERT IGNORE INTO `migration` VALUES ('20190922205826','');
INSERT IGNORE INTO `migration` VALUES ('20191008194238','');
INSERT IGNORE INTO `migration` VALUES ('20191010131430','');
INSERT IGNORE INTO `migration` VALUES ('20191207204427','');
INSERT IGNORE INTO `migration` VALUES ('20191207220736','');
INSERT IGNORE INTO `migration` VALUES ('20200120201756','');
INSERT IGNORE INTO `migration` VALUES ('20200219183248','');
INSERT IGNORE INTO `migration` VALUES ('20200308205855','');
INSERT IGNORE INTO `migration` VALUES ('20200308210130','');
INSERT IGNORE INTO `migration` VALUES ('20200322214440','');
INSERT IGNORE INTO `migration` VALUES ('20200322214624','');
INSERT IGNORE INTO `migration` VALUES ('20200417175201','');
INSERT IGNORE INTO `migration` VALUES ('20200418230432','');
INSERT IGNORE INTO `migration` VALUES ('20200418230605','');
INSERT IGNORE INTO `migration` VALUES ('20200420215928','');
INSERT IGNORE INTO `migration` VALUES ('20200425182634','');
INSERT IGNORE INTO `migration` VALUES ('20200509103709','');
INSERT IGNORE INTO `migration` VALUES ('20200515172220','');
INSERT IGNORE INTO `migration` VALUES ('20200515195546','');
INSERT IGNORE INTO `migration` VALUES ('20200516123847','');
INSERT IGNORE INTO `migration` VALUES ('20200524221534','');
INSERT IGNORE INTO `migration` VALUES ('20200524224611','');
INSERT IGNORE INTO `migration` VALUES ('20200614113230','');
INSERT IGNORE INTO `migration` VALUES ('20200621214452','');
INSERT IGNORE INTO `migration` VALUES ('20200801183357','');
INSERT IGNORE INTO `migration` VALUES ('20200904101559','');
INSERT IGNORE INTO `migration` VALUES ('20200905151040','');
INSERT IGNORE INTO `migration` VALUES ('20200905232458','');
INSERT IGNORE INTO `migration` VALUES ('20200906184746','');
INSERT IGNORE INTO `migration` VALUES ('20201025195822','');
INSERT IGNORE INTO `migration` VALUES ('20201121181647','');
INSERT IGNORE INTO `migration` VALUES ('20201218152741','');
INSERT IGNORE INTO `migration` VALUES ('20201218220204','');
INSERT IGNORE INTO `migration` VALUES ('20201219145028','');
INSERT IGNORE INTO `migration` VALUES ('20210207192805','');
INSERT IGNORE INTO `migration` VALUES ('20210209204715','');
INSERT IGNORE INTO `migration` VALUES ('20210220222121','');
INSERT IGNORE INTO `migration` VALUES ('20210221111953','');
INSERT IGNORE INTO `migration` VALUES ('20210321185225','');
INSERT IGNORE INTO `migration` VALUES ('20210328191017','');
INSERT IGNORE INTO `migration` VALUES ('20210403145503','');
INSERT IGNORE INTO `migration` VALUES ('20210403220653','');
INSERT IGNORE INTO `migration` VALUES ('20210407170753','');
INSERT IGNORE INTO `migration` VALUES ('20210411113105','');
INSERT IGNORE INTO `migration` VALUES ('20210411161337','');
INSERT IGNORE INTO `migration` VALUES ('20210413131057','');
INSERT IGNORE INTO `migration` VALUES ('20210527105701','');
INSERT IGNORE INTO `migration` VALUES ('20210603174608','');
INSERT IGNORE INTO `migration` VALUES ('20210709191101','');
INSERT IGNORE INTO `migration` VALUES ('20210709211508','');
INSERT IGNORE INTO `migration` VALUES ('20210711173657','');
INSERT IGNORE INTO `migration` VALUES ('20210713213622','');
INSERT IGNORE INTO `migration` VALUES ('20210725153703','');
INSERT IGNORE INTO `migration` VALUES ('20210727204942','');
INSERT IGNORE INTO `migration` VALUES ('20210727211037','');
INSERT IGNORE INTO `migration` VALUES ('20210729142940','');
INSERT IGNORE INTO `migration` VALUES ('20210802081716','');
INSERT IGNORE INTO `migration` VALUES ('20210829194722','');
INSERT IGNORE INTO `migration` VALUES ('20211212151642','');
INSERT IGNORE INTO `migration` VALUES ('20211212210054','');
INSERT IGNORE INTO `migration` VALUES ('20220112211537','');
INSERT IGNORE INTO `migration` VALUES ('20220616145228','');
INSERT IGNORE INTO `migration` VALUES ('20220815200851','');
INSERT IGNORE INTO `migration` VALUES ('20221002120521','');
INSERT IGNORE INTO `migration` VALUES ('20221113170740','');
INSERT IGNORE INTO `migration` VALUES ('20221228112131','');
INSERT IGNORE INTO `migration` VALUES ('20230104152903','');
INSERT IGNORE INTO `migration` VALUES ('20230307171848','');
INSERT IGNORE INTO `migration` VALUES ('20230611170341','');
INSERT IGNORE INTO `migration` VALUES ('20230824132533','');
INSERT IGNORE INTO `migration` VALUES ('20230828125443','');
INSERT IGNORE INTO `migration` VALUES ('20230831155832','');
INSERT IGNORE INTO `migration` VALUES ('20230903143017','');
INSERT IGNORE INTO `migration` VALUES ('20230913202615','');
INSERT IGNORE INTO `migration` VALUES ('20231022144641','');
INSERT IGNORE INTO `migration` VALUES ('20231108231513','');
INSERT IGNORE INTO `migration` VALUES ('20231121191822','');
INSERT IGNORE INTO `migration` VALUES ('20240114224713','');
INSERT IGNORE INTO `migration` VALUES ('20240304153738','');
INSERT IGNORE INTO `migration` VALUES ('20240309111148','');
INSERT IGNORE INTO `migration` VALUES ('20240311173251','');
INSERT IGNORE INTO `migration` VALUES ('20240313230538','');
INSERT IGNORE INTO `migration` VALUES ('20240314214802','');
INSERT IGNORE INTO `migration` VALUES ('20240315093418','');
INSERT IGNORE INTO `migration` VALUES ('20240315104205','');
INSERT IGNORE INTO `migration` VALUES ('20240315110428','');
INSERT IGNORE INTO `migration` VALUES ('20240329170952','');
INSERT IGNORE INTO `migration` VALUES ('20240406125227','');
INSERT IGNORE INTO `migration` VALUES ('20240603172746','');
INSERT IGNORE INTO `migration` VALUES ('20240919130957','');
INSERT IGNORE INTO `migration` VALUES ('20241028131622','');
INSERT IGNORE INTO `migration` VALUES ('20241118123644','');
INSERT IGNORE INTO `migration` VALUES ('20241119115012','');
INSERT IGNORE INTO `migration` VALUES ('20250317174522','');
INSERT IGNORE INTO `migration` VALUES ('20250323212553','');
INSERT IGNORE INTO `migration` VALUES ('20250402173109','');
INSERT IGNORE INTO `migration` VALUES ('20250624092830','');
INSERT IGNORE INTO `migration` VALUES ('20250813093602','');
INSERT IGNORE INTO `migration` VALUES ('20251001113831','');
INSERT IGNORE INTO `migration` VALUES ('20251108154913','');
INSERT IGNORE INTO `migration` VALUES ('20251118125156','');
INSERT IGNORE INTO `migration` VALUES ('20260123000717','');
INSERT IGNORE INTO `migration` VALUES ('20260224113347','');
INSERT IGNORE INTO `migration` VALUES ('20260224122023','');
INSERT IGNORE INTO `migration` VALUES ('20260224215050','');
INSERT IGNORE INTO `migration` VALUES ('20260225114726','');
INSERT IGNORE INTO `migration` VALUES ('20260226172819','');
INSERT IGNORE INTO `migration` VALUES ('20260324120000','');
INSERT IGNORE INTO `migration` VALUES ('20260405194817','');
INSERT IGNORE INTO `migration` VALUES ('20260411013328','');
INSERT IGNORE INTO `migration` VALUES ('20260415143536','');
INSERT IGNORE INTO `migration` VALUES ('20260519120000','');
INSERT IGNORE INTO `migration` VALUES ('20260607132257','');
INSERT IGNORE INTO `migration` VALUES ('20260617153629','');
INSERT IGNORE INTO `migration` VALUES ('20260619155410','');
INSERT IGNORE INTO `migration` VALUES ('20260627101958','');
INSERT IGNORE INTO `migration` VALUES ('20260707094311','');
INSERT IGNORE INTO `migration` VALUES ('20260719145922','');
INSERT IGNORE INTO `migration` VALUES ('20260729090000','');

SET FOREIGN_KEY_CHECKS = 1;
