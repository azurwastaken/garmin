CREATE TABLE `caffeine` (
	`time` text PRIMARY KEY,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`mg` real NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `caffeine_day` ON `caffeine` (`day`);