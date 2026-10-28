package main

import (
	"os"

	"gopkg.in/yaml.v3"
)

// Config holds all server configuration.
//
// StorageRoot keeps the content Markdown (year/month/*.md + images).
// MetricsRoot keeps the engagement metrics in a separate tree
// (platform/year/month/day-title.md).
type Config struct {
	StorageRoot string `yaml:"storage_root"`
	MetricsRoot string `yaml:"metrics_root"`
	Port        int    `yaml:"port"`
	Host        string `yaml:"host"`
	LogLevel    string `yaml:"log_level"`
}

// LoadFromFile merges a YAML config file into cfg, only overwriting zero-value fields.
func (c *Config) LoadFromFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	tmp := &Config{}
	if err := yaml.Unmarshal(data, tmp); err != nil {
		return err
	}
	// Only apply file values when the flag value is still the default/zero
	if c.StorageRoot == "" && tmp.StorageRoot != "" {
		c.StorageRoot = tmp.StorageRoot
	}
	if c.MetricsRoot == "" && tmp.MetricsRoot != "" {
		c.MetricsRoot = tmp.MetricsRoot
	}
	if c.Port == 0 && tmp.Port != 0 {
		c.Port = tmp.Port
	}
	if c.Host == "" && tmp.Host != "" {
		c.Host = tmp.Host
	}
	if c.LogLevel == "" && tmp.LogLevel != "" {
		c.LogLevel = tmp.LogLevel
	}
	return nil
}
