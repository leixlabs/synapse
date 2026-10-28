package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// runMetricsMigration moves legacy `engagement_*` front matter keys out of the
// existing content Markdown files into the dedicated metrics tree
// (platform/year/month/day-title.md), leaving the content files untouched otherwise.
//
// With apply == false it only reports what would change (dry run).
func runMetricsMigration(cfg *Config, apply bool) error {
	mode := "DRY RUN"
	if apply {
		mode = "APPLY"
	}
	log.Printf("[migrate] %s — content: %s → metrics: %s", mode, cfg.StorageRoot, cfg.MetricsRoot)

	var scanned, pending, migrated, noMetrics, failed int
	samples := make([]string, 0, 5)

	err := filepath.Walk(cfg.StorageRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		scanned++

		hasMetrics, migrateErr := migrateContentFile(cfg, path, apply)
		if migrateErr != nil {
			failed++
			log.Printf("[migrate] ERROR %s: %v", path, migrateErr)
			return nil
		}
		if !hasMetrics {
			noMetrics++
			return nil
		}

		pending++
		if apply {
			migrated++
		} else if len(samples) < 5 {
			rel, _ := filepath.Rel(cfg.StorageRoot, path)
			samples = append(samples, rel)
		}
		return nil
	})
	if err != nil {
		return err
	}

	log.Printf("[migrate] scanned=%d with_metrics=%d without_metrics=%d migrated=%d failed=%d",
		scanned, pending, noMetrics, migrated, failed)
	if !apply && len(samples) > 0 {
		log.Printf("[migrate] examples: %s", strings.Join(samples, ", "))
		log.Printf("[migrate] nothing written — re-run with --migrate-apply to perform the migration")
	}
	if failed > 0 {
		return fmt.Errorf("%d file(s) failed", failed)
	}
	return nil
}

// migrateContentFile extracts the engagement metrics of a single content file
// and (when apply is true) writes them to the metrics tree and strips them from
// the content front matter. It reports whether the file carried any metrics.
func migrateContentFile(cfg *Config, path string, apply bool) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}

	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return false, nil
	}

	closeIdx := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			closeIdx = i
			break
		}
	}
	if closeIdx < 0 {
		return false, nil
	}

	meta := make(map[string]string, 10)
	engagement := &EngagementMetrics{}
	hasMetrics := false

	kept := make([]string, 0, len(lines))
	kept = append(kept, lines[0])

	for _, line := range lines[1:closeIdx] {
		key, raw, ok := splitFrontMatterLine(line)
		if !ok {
			kept = append(kept, line)
			continue
		}

		switch key {
		case "hash_id", "source", "title", "url", "original_date", "collected_at",
			"author_username", "author_display_name":
			meta[key] = unquoteYAML(raw)
			kept = append(kept, line)
		case "engagement_views":
			engagement.Views = parseIntPtr(raw)
			hasMetrics = true
		case "engagement_likes":
			engagement.Likes = parseIntPtr(raw)
			hasMetrics = true
		case "engagement_comments":
			engagement.Comments = parseIntPtr(raw)
			hasMetrics = true
		case "engagement_reposts":
			engagement.Reposts = parseIntPtr(raw)
			hasMetrics = true
		case "engagement_reads":
			engagement.Reads = parseIntPtr(raw)
			hasMetrics = true
		case "engagement_collects":
			engagement.Collects = parseIntPtr(raw)
			hasMetrics = true
		default:
			kept = append(kept, line)
		}
	}

	if !hasMetrics {
		return false, nil
	}
	if !apply {
		return true, nil
	}

	hashID := meta["hash_id"]
	if hashID == "" {
		hashID = hashURL(meta["url"])
	}

	relPath, err := filepath.Rel(cfg.StorageRoot, path)
	if err != nil {
		relPath = strings.TrimPrefix(path, cfg.StorageRoot)
	}

	content := CollectedContent{
		Source:      meta["source"],
		Title:       meta["title"],
		URL:         meta["url"],
		Timestamp:   meta["original_date"],
		CollectedAt: meta["collected_at"],
		Author: AuthorInfo{
			Username:    meta["author_username"],
			DisplayName: meta["author_display_name"],
		},
		Engagement: engagement,
	}

	result, err := SaveMetrics(cfg, content, hashID, filepath.ToSlash(relPath))
	if err != nil {
		return false, err
	}
	if result == nil {
		return false, nil
	}

	kept = append(kept, lines[closeIdx:]...)
	if err := os.WriteFile(path, []byte(strings.Join(kept, "\n")), 0644); err != nil {
		return false, err
	}

	log.Printf("[migrate] %s → %s", filepath.ToSlash(relPath), result.Path)
	return true, nil
}

// splitFrontMatterLine splits "key: value" pairs, ignoring nested list items
// and comment lines.
func splitFrontMatterLine(line string) (string, string, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "-") {
		return "", "", false
	}
	idx := strings.Index(trimmed, ":")
	if idx <= 0 {
		return "", "", false
	}
	key := strings.TrimSpace(trimmed[:idx])
	return key, strings.TrimSpace(trimmed[idx+1:]), true
}

func unquoteYAML(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
			value = value[1 : len(value)-1]
		}
	}
	// Undo the escaping produced by %q when writing front matter
	value = strings.ReplaceAll(value, `\"`, `"`)
	value = strings.ReplaceAll(value, `\n`, "\n")
	value = strings.ReplaceAll(value, `\\`, `\`)
	return value
}

func parseIntPtr(value string) *int {
	n, err := strconv.Atoi(unquoteYAML(value))
	if err != nil {
		return nil
	}
	return &n
}
