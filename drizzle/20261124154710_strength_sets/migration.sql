CREATE TABLE `strength_sets` (
	`activity_id` integer NOT NULL,
	`idx` integer NOT NULL,
	`start_time` text,
	`category` text,
	`exercise_name` text,
	`reps` integer,
	`weight_kg` real,
	`duration_s` real,
	`source` text NOT NULL,
	CONSTRAINT `strength_sets_pk` PRIMARY KEY(`activity_id`, `idx`),
	CONSTRAINT `fk_strength_sets_activity_id_activities_id_fk` FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `strength_sets_exercise` ON `strength_sets` (`category`,`exercise_name`);