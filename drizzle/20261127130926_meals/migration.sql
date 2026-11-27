CREATE TABLE `meals` (
	`time` text PRIMARY KEY,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `meals_day` ON `meals` (`day`);