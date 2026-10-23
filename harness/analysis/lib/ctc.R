# The registry and assets helpers for analysis scripts run in ctc-analysis:1.
#
# The R mirror of lib/ctc.py: the same calls write the same files. A script loads
# it with source("/opt/ctc/ctc.R"). Scripts record each number with rec(), write
# the section's registry with save_numbers(), and read numbers back with reg().
# The one assets script sets variables with put_var() and writes them with
# write_variables(). Everything lands under $CTC_OUT (default /work/output).

.ctc <- new.env(parent = emptyenv())
.ctc$numbers <- list()
.ctc$variables <- list()

ctc_out <- function() Sys.getenv("CTC_OUT", "/work/output")

ctc_check_number <- function(value) {
  if (!is.numeric(value) || length(value) != 1 || !is.finite(value)) stop(deparse(value), " is not a finite number")
}

# Integer-valued numbers print bare; other numbers with 10 significant digits.
ctc_format <- function(value) {
  value <- as.numeric(value)
  if (value == 0) return("0")
  if (value == round(value)) return(sprintf("%.0f", value))
  sprintf("%.10g", value)
}

ctc_section_path <- function(section) {
  if (!grepl("^[A-Za-z0-9][A-Za-z0-9_-]*$", section)) {
    stop(sprintf('"%s" is not a section name (letters, digits, _ and -)', section))
  }
  file.path(ctc_out(), "numbers", paste0(section, ".csv"))
}

# A CSV field, quoted only when it holds a comma, a quote or a line break.
ctc_csv_field <- function(x) {
  x <- as.character(x)
  quote <- grepl('[",\n\r]', x)
  x[quote] <- paste0('"', gsub('"', '""', x[quote], fixed = TRUE), '"')
  x
}

ctc_write_csv <- function(path, header, columns) {
  body <- do.call(paste, c(lapply(columns, ctc_csv_field), sep = ","))
  writeLines(c(paste(header, collapse = ","), body), path)
}

ctc_yaml_escape <- function(text) {
  text <- gsub("\\", "\\\\", text, fixed = TRUE)
  text <- gsub('"', '\\"', text, fixed = TRUE)
  gsub("\n", "\\n", text, fixed = TRUE)
}

rec <- function(key, value, note = "") {
  if (!is.character(key) || length(key) != 1 || is.na(key) || key == "") stop("a key must be a non-empty string")
  ctc_check_number(value)
  if (key %in% names(.ctc$numbers)) stop(sprintf('"%s" is already recorded in this section', key))
  .ctc$numbers[[key]] <- list(value = as.numeric(value), note = as.character(note))
  invisible(value)
}

save_numbers <- function(section) {
  path <- ctc_section_path(section)
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  numbers <- .ctc$numbers
  ctc_write_csv(
    path,
    c("name", "value", "note"),
    list(
      names(numbers),
      vapply(numbers, function(n) ctc_format(n$value), ""),
      vapply(numbers, function(n) n$note, "")
    )
  )
  .ctc$numbers <- list()
  invisible(path)
}

# The value recorded under key in numbers/<file>.csv; stops unless exactly one row has it.
reg <- function(file, key) {
  rows <- read.csv(
    ctc_section_path(file),
    colClasses = "character",
    na.strings = character(0),
    stringsAsFactors = FALSE,
    check.names = FALSE
  )
  hits <- rows$value[rows$name == key]
  if (length(hits) != 1) {
    stop(sprintf('%d rows named "%s" in numbers/%s.csv; expected exactly one', length(hits), key, file))
  }
  as.numeric(hits)
}

put_var <- function(variable, value, source, rendered = NULL) {
  if (!grepl("^[A-Za-z_][A-Za-z0-9_]*$", variable)) {
    stop(sprintf('"%s" is not a variable name (letters, digits and _)', variable))
  }
  # The source is the registry file and key it came from: output/numbers/<section>.csv#<key>.
  if (!is.character(source) || length(source) != 1 || !grepl("^output/numbers/[^/#\\n]+\\.csv#.+\\z", source, perl = TRUE)) {
    stop(sprintf('"%s" is not a source: expected output/numbers/<section>.csv#<key>', paste(source, collapse = " ")))
  }
  if (variable %in% names(.ctc$variables)) stop(sprintf('variable "%s" is already set', variable))
  ctc_check_number(value)
  shown <- if (is.null(rendered)) ctc_format(value) else as.character(rendered)
  .ctc$variables[[variable]] <- list(value = as.numeric(value), rendered = shown, source = as.character(source))
  invisible(value)
}

write_variables <- function() {
  folder <- file.path(ctc_out(), "assets")
  dir.create(folder, recursive = TRUE, showWarnings = FALSE)
  variables <- .ctc$variables
  writeLines(
    vapply(names(variables), function(name) sprintf('%s: "%s"', name, ctc_yaml_escape(variables[[name]]$rendered)), ""),
    file.path(folder, "_variables.yml")
  )
  ctc_write_csv(
    file.path(folder, "variables_sources.csv"),
    c("variable", "value", "rendered", "source"),
    list(
      names(variables),
      vapply(variables, function(v) ctc_format(v$value), ""),
      vapply(variables, function(v) v$rendered, ""),
      vapply(variables, function(v) v$source, "")
    )
  )
  .ctc$variables <- list()
  invisible(folder)
}
