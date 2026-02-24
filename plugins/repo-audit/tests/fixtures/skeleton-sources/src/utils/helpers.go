package utils

import (
	"fmt"
	"strings"
)

type Config struct {
	Host string
	Port int
}

type Logger interface {
	Log(msg string)
	Error(msg string)
}

func NewConfig(host string, port int) *Config {
	return &Config{Host: host, Port: port}
}

func (c *Config) String() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

func ParseArgs(args []string) map[string]string {
	result := make(map[string]string)
	for _, arg := range args {
		parts := strings.SplitN(arg, "=", 2)
		if len(parts) == 2 {
			result[parts[0]] = parts[1]
		}
	}
	return result
}
