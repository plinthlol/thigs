#!/usr/bin/env fish
# codexy.fish
#
# Interactive picker to manage OpenAI-compatible providers for OpenAI's
# Codex CLI, with support for MULTIPLE models per provider.

set -g CS_CODEX_DIR $HOME/.codex
set -g CS_DIR $CS_CODEX_DIR/codex-switch
set -g CS_PROVIDERS_DIR $CS_DIR/providers
set -g CS_CATALOGS_DIR $CS_DIR/catalogs
set -g CS_ACTIVE_FILE $CS_DIR/active
set -g CS_ENV_FILE $CS_DIR/env.fish
set -g CS_CODEX_CONFIG $CS_CODEX_DIR/config.toml
set -g CS_FISH_CONFIG $HOME/.config/fish/config.fish
set -g CS_MARK_BEGIN "# >>> codex-switch managed block >>>"
set -g CS_MARK_END "# <<< codex-switch managed block <<<"

function _cs_init
    mkdir -p $CS_PROVIDERS_DIR
    mkdir -p $CS_CATALOGS_DIR
    chmod 700 $CS_DIR
    chmod 700 $CS_PROVIDERS_DIR
    mkdir -p $CS_CODEX_DIR

    if not test -f $CS_ENV_FILE
        touch $CS_ENV_FILE
    end
    chmod 600 $CS_ENV_FILE

    mkdir -p (dirname $CS_FISH_CONFIG)
    touch $CS_FISH_CONFIG
    if not grep -q "codex-switch/env.fish" $CS_FISH_CONFIG
        echo "" >> $CS_FISH_CONFIG
        echo "# codex-switch: load active Codex provider api key" >> $CS_FISH_CONFIG
        echo "test -f $CS_ENV_FILE; and source $CS_ENV_FILE" >> $CS_FISH_CONFIG
    end
end

function _cs_list_provider_names
    find $CS_PROVIDERS_DIR -maxdepth 1 -type f -printf '%f\n' 2>/dev/null
end

function _cs_active_name
    if test -f $CS_ACTIVE_FILE
        cat $CS_ACTIVE_FILE
    end
end

function _cs_read_provider_field
    set -l file $CS_PROVIDERS_DIR/$argv[1]
    if not test -f $file
        return 1
    end
    grep "^$argv[2]=" $file | string replace "$argv[2]=" ""
end

function _cs_read_provider_models
    set -l csv (_cs_read_provider_field $argv[1] models)
    if test -n "$csv"
        string split ',' -- $csv
    end
end

function _cs_fetch_models_json
    if not type -q curl
        return 1
    end
    set -l base_url (string trim -r -c '/' -- $argv[1])
    curl -s -m 10 -H "Authorization: Bearer $argv[2]" "$base_url/models" 2>/dev/null
end

function _cs_parse_model_ids
    grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4
end

function _cs_pick_models
    set -l base_url $argv[1]
    set -l api_key $argv[2]

    if not type -q curl
        echo "curl not found — skipping model fetch." 1>&2
        return 1
    end

    echo "Fetching models from $base_url/models ..." 1>&2
    set -l raw (_cs_fetch_models_json $base_url $api_key)
    if test -z "$raw"
        echo "Could not fetch model list (no response / no models endpoint)." 1>&2
        return 1
    end

    set -l ids (echo $raw | _cs_parse_model_ids)
    set -l uniq_ids
    for id in $ids
        if not contains -- $id $uniq_ids
            set -a uniq_ids $id
        end
    end

    if test (count $uniq_ids) -eq 0
        echo "No models found in response." 1>&2
        return 1
    end

    echo "" 1>&2
    echo "Available models:" 1>&2
    set -l i 1
    for id in $uniq_ids
        echo "$i) $id" 1>&2
        set i (math $i + 1)
    end
    read -P 'Pick models — e.g. "1,3,4", "a"/"all" for all, or Enter to skip: ' -l choice
    if test -z "$choice"
        return 1
    end

    set -l picked
    if string match -qir '^(a|all|\*)$' -- $choice
        set picked $uniq_ids
    else
        for tok in (string split ',' -- $choice)
            set -l tok (string trim -- $tok)
            if string match -qr '^[0-9]+$' -- $tok
                set -l idx (math $tok)
                if test $idx -ge 1 -a $idx -le (count $uniq_ids)
                    if not contains -- $uniq_ids[$idx] $picked
                        set -a picked $uniq_ids[$idx]
                    end
                end
            end
        end
    end

    if test (count $picked) -eq 0
        echo "No valid selections." 1>&2
        return 1
    end
    for id in $picked
        echo $id
    end
    return 0
end

function _cs_choose_models
    set -l base_url $argv[1]
    set -l api_key $argv[2]

    read -P 'Fetch model list from this provider now? [Y/n] ' -l do_fetch
    set -l models
    if not string match -qi 'n*' -- $do_fetch
        set models (_cs_pick_models $base_url $api_key)
    end
    if test (count $models) -eq 0
        read -P 'Enter model name(s) manually, comma-separated (or leave blank): ' -l manual
        if test -n "$manual"
            for tok in (string split ',' -- $manual)
                set -l tok (string trim -- $tok)
                if test -n "$tok"
                    set -a models $tok
                end
            end
        end
    end
    for m in $models
        echo $m
    end
end

function _cs_choose_default
    set -l models $argv
    if test (count $models) -le 1
        if test (count $models) -eq 1
            echo $models[1]
        end
        return
    end

    echo "" 1>&2
    echo "Models added:" 1>&2
    set -l i 1
    for m in $models
        echo "$i) $m" 1>&2
        set i (math $i + 1)
    end
    read -P "Which should be the default? [1-"(count $models)"] (default: 1): " -l defidx
    set -l di 1
    if string match -qr '^[0-9]+$' -- $defidx
        set -l cand (math $defidx)
        if test $cand -ge 1 -a $cand -le (count $models)
            set di $cand
        end
    end
    echo $models[$di]
end

function _cs_json_escape
    string replace -a '\\' '\\\\' -- $argv[1] | string replace -a '"' '\"'
end

function _cs_write_catalog
    set -l name $argv[1]
    set -l models $argv[2..-1]
    set -l path $CS_CATALOGS_DIR/$name.json

    if test (count $models) -eq 0
        rm -f $path
        return
    end

    set -l tmp (mktemp)
    echo '{' > $tmp
    echo '  "models": [' >> $tmp
    set -l n (count $models)
    for i in (seq 1 $n)
        set -l id $models[$i]
        set -l esc (_cs_json_escape $id)
        set -l prio (math $i - 1)
        set -l line "    {\"slug\": \"$esc\", \"display_name\": \"$esc\", \"description\": \"Added via codexy\", \"supported_reasoning_levels\": [{\"effort\": \"medium\", \"description\": \"Medium reasoning effort\"}], \"shell_type\": \"shell_command\", \"visibility\": \"list\", \"supported_in_api\": true, \"priority\": $prio, \"base_instructions\": \"default\", \"support_verbosity\": false, \"truncation_policy\": {\"mode\": \"bytes\", \"limit\": 10000}, \"experimental_supported_tools\": [], \"availability_nux\": null, \"upgrade\": null}"
        if test $i -lt $n
            echo "$line," >> $tmp
        else
            echo "$line" >> $tmp
        end
    end
    echo '  ]' >> $tmp
    echo '}' >> $tmp
    mv $tmp $path
end

function _cs_add_provider
    echo ""
    read -P 'Provider name: ' -l name
    if test -z "$name"
        echo "Name can't be empty."
        return
    end
    set name (string replace -a ' ' '-' -- $name)

    if test -f $CS_PROVIDERS_DIR/$name
        read -P "Provider '$name' already exists. Overwrite? [y/N] " -l confirm
        if not string match -qi 'y*' -- $confirm
            return
        end
    end

    read -P 'Base URL (e.g. https://api.example.com/v1): ' -l base_url
    if test -z "$base_url"
        echo "Base URL can't be empty."
        return
    end

    read -s -P 'API key (hidden): ' -l api_key
    echo ""
    if test -z "$api_key"
        echo "API key can't be empty."
        return
    end

    read -P 'Wire API [responses/chat] (default: responses): ' -l wire_api
    if test -z "$wire_api"
        set wire_api responses
    end

    set -l models (_cs_choose_models $base_url $api_key)
    set -l default_model (_cs_choose_default $models)
    set -l models_csv (string join ',' -- $models)

    set -l tmp (mktemp)
    echo "base_url=$base_url" > $tmp
    echo "api_key=$api_key" >> $tmp
    echo "wire_api=$wire_api" >> $tmp
    echo "default_model=$default_model" >> $tmp
    echo "models=$models_csv" >> $tmp
    mv $tmp $CS_PROVIDERS_DIR/$name
    chmod 600 $CS_PROVIDERS_DIR/$name

    if test (count $models) -gt 0
        echo "Saved provider '$name' with "(count $models)" model(s), default: $default_model"
    else
        echo "Saved provider '$name' (no models set — Codex will use its own default)."
    end

    read -P 'Activate it now? [y/N] ' -l act
    if string match -qi 'y*' -- $act
        _cs_activate_provider $name
    end
end

function _cs_emit_block
    set -l name $argv[1]
    set -l base_url $argv[2]
    set -l wire_api $argv[3]
    set -l default_model $argv[4]
    set -l catalog_path $argv[5]

    echo "$CS_MARK_BEGIN"
    if test -n "$default_model"
        echo "model = \"$default_model\""
    end
    if test -n "$catalog_path"
        echo "model_catalog_json = \"$catalog_path\""
    end
    echo "model_provider = \"codexswitch\""
    echo ""
    echo "[model_providers.codexswitch]"
    echo "name = \"$name\""
    echo "base_url = \"$base_url\""
    echo "wire_api = \"$wire_api\""
    echo "env_key = \"CODEX_SWITCH_API_KEY\""
    echo "$CS_MARK_END"
end

function _cs_write_codex_config
    set -l name $argv[1]
    set -l base_url $argv[2]
    set -l wire_api $argv[3]
    set -l default_model $argv[4]
    set -l catalog_path $argv[5]

    touch $CS_CODEX_CONFIG

    # Step 1: strip any existing managed block, wherever it currently sits
    # (a previous run may have left it nested inside a [projects.*] table
    # or some other table — see step 2 for why that's wrong). Stripping
    # it first and always reinserting fresh makes this self-healing.
    #
    # IMPORTANT: something else (Codex itself, editing config.toml to add
    # a new [projects."..."] trust entry, say) can append unrelated lines
    # after our END marker without ever knowing the markers exist, and on
    # a later run those lines are now sitting between our BEGIN and END.
    # Deleting everything between the markers unconditionally would throw
    # that content away. So: only drop lines that are actually part of
    # what we generate; anything else found inside the old block is
    # foreign content and gets preserved, appended right after our
    # regenerated block.
    set -l stripped (mktemp)
    set -l foreign (mktemp)
    set -l in_block 0
    while read -l line
        if test "$line" = "$CS_MARK_BEGIN"
            set in_block 1
            continue
        end
        if test "$line" = "$CS_MARK_END"
            set in_block 0
            continue
        end
        if test $in_block -eq 0
            echo "$line" >> $stripped
            continue
        end
        # Inside the old block: is this one of ours?
        if string match -qr '^(model|model_catalog_json|model_provider) = ' -- "$line"
            continue
        end
        if test "$line" = "[model_providers.codexswitch]"
            continue
        end
        if string match -qr '^(name|base_url|wire_api|env_key) = ' -- "$line"
            continue
        end
        if test -z "$line"
            continue
        end
        # Not one of ours — foreign content that landed inside the old
        # block. Keep it.
        echo "$line" >> $foreign
    end < $CS_CODEX_CONFIG

    # Step 2: reinsert it BEFORE the first [table] header rather than at
    # the end of the file (or wherever it happened to land before): a
    # bare `model = ...` key placed after any [table] header belongs to
    # that table in TOML, not to the document root, so Codex would never
    # see it as top-level config.
    set -l tmp (mktemp)
    set -l block (mktemp)
    _cs_emit_block $name $base_url $wire_api $default_model $catalog_path > $block
    set -l inserted 0
    while read -l line
        if test $inserted -eq 0; and string match -qr '^[[:space:]]*\[' -- "$line"
            cat $block >> $tmp
            echo "" >> $tmp
            set inserted 1
        end
        echo "$line" >> $tmp
    end < $stripped
    rm -f $stripped

    if test $inserted -eq 0
        if test -s $tmp
            echo "" >> $tmp
        end
        cat $block >> $tmp
    end
    if test -s $foreign
        echo "" >> $tmp
        cat $foreign >> $tmp
    end
    mv $tmp $CS_CODEX_CONFIG
    rm -f $block $foreign
end

function _cs_activate_provider
    set -l name $argv[1]
    if not test -f $CS_PROVIDERS_DIR/$name
        echo "No such provider: $name"
        return
    end

    set -l base_url (_cs_read_provider_field $name base_url)
    set -l api_key (_cs_read_provider_field $name api_key)
    set -l wire_api (_cs_read_provider_field $name wire_api)
    set -l default_model (_cs_read_provider_field $name default_model)
    set -l models (_cs_read_provider_models $name)

    echo "set -gx CODEX_SWITCH_API_KEY \"$api_key\"" > $CS_ENV_FILE
    chmod 600 $CS_ENV_FILE

    _cs_write_catalog $name $models
    set -l catalog_path ""
    if test (count $models) -gt 0
        set catalog_path $CS_CATALOGS_DIR/$name.json
    end

    _cs_write_codex_config $name $base_url $wire_api $default_model $catalog_path

    echo $name > $CS_ACTIVE_FILE
    set -gx CODEX_SWITCH_API_KEY $api_key

    if test (count $models) -gt 1
        echo "Activated provider '$name' — default model: $default_model ("(count $models)" models available; use /model inside Codex to switch)."
    else if test (count $models) -eq 1
        echo "Activated provider '$name' (model: $default_model)."
    else
        echo "Activated provider '$name' (no model set)."
    end
    echo "(Already active in this shell. New shells pick it up automatically.)"
end

function _cs_change_models
    set -l name $argv[1]
    if not test -f $CS_PROVIDERS_DIR/$name
        echo "No such provider: $name"
        return
    end
    set -l base_url (_cs_read_provider_field $name base_url)
    set -l api_key (_cs_read_provider_field $name api_key)
    set -l wire_api (_cs_read_provider_field $name wire_api)

    set -l models (_cs_choose_models $base_url $api_key)
    set -l default_model (_cs_choose_default $models)
    set -l models_csv (string join ',' -- $models)

    set -l tmp (mktemp)
    echo "base_url=$base_url" > $tmp
    echo "api_key=$api_key" >> $tmp
    echo "wire_api=$wire_api" >> $tmp
    echo "default_model=$default_model" >> $tmp
    echo "models=$models_csv" >> $tmp
    mv $tmp $CS_PROVIDERS_DIR/$name
    chmod 600 $CS_PROVIDERS_DIR/$name

    if test (count $models) -gt 0
        echo "Updated '$name' -> "(count $models)" model(s), default: $default_model"
    else
        echo "Updated '$name' -> no models set."
    end

    if test (_cs_active_name) = "$name"
        _cs_activate_provider $name
    end
end

function _cs_remove_provider
    set -l name $argv[1]
    if not test -f $CS_PROVIDERS_DIR/$name
        echo "No such provider: $name"
        return
    end
    read -P "Remove provider '$name'? [y/N] " -l confirm
    if not string match -qi 'y*' -- $confirm
        return
    end
    rm -f $CS_PROVIDERS_DIR/$name
    rm -f $CS_CATALOGS_DIR/$name.json
    if test (_cs_active_name) = "$name"
        rm -f $CS_ACTIVE_FILE
        echo "" > $CS_ENV_FILE
        echo "Removed '$name' (it was active — no provider active now)."
    else
        echo "Removed '$name'."
    end
end

function _cs_manage_menu
    while true
        set -l names (_cs_list_provider_names)
        if test (count $names) -eq 0
            echo "No providers saved yet."
            return
        end
        set -l active (_cs_active_name)

        echo ""
        echo "== Providers =="
        set -l i 1
        for n in $names
            set -l models (_cs_read_provider_models $n)
            set -l dm (_cs_read_provider_field $n default_model)
            set -l label $n
            if test (count $models) -gt 1
                set label "$n ("(count $models)" models, default: $dm)"
            else if test (count $models) -eq 1
                set label "$n ($dm)"
            end
            if test "$n" = "$active"
                echo "$i) $label  [active]"
            else
                echo "$i) $label"
            end
            set i (math $i + 1)
        end
        echo "b) Back"
        read -P 'Select provider number: ' -l choice
        if test "$choice" = "b"
            return
        end
        if not string match -qr '^[0-9]+$' -- $choice
            echo "Invalid choice."
            continue
        end
        set -l idx (math $choice)
        if test $idx -lt 1 -o $idx -gt (count $names)
            echo "Invalid choice."
            continue
        end
        set -l sel $names[$idx]

        echo ""
        echo "-- $sel --"
        echo "1) Activate"
        echo "2) Remove"
        echo "3) Change models"
        echo "b) Back"
        read -P 'Choose: ' -l action
        switch $action
            case 1
                _cs_activate_provider $sel
            case 2
                _cs_remove_provider $sel
            case 3
                _cs_change_models $sel
            case '*'
                continue
        end
    end
end

function _cs_main_menu
    while true
        echo ""
        echo "===== Codex Provider Switcher ====="
        set -l active (_cs_active_name)
        if test -n "$active"
            set -l models (_cs_read_provider_models $active)
            set -l dm (_cs_read_provider_field $active default_model)
            if test (count $models) -gt 1
                echo "Active provider: $active (default: $dm, "(count $models)" models — /model to switch in Codex)"
            else if test (count $models) -eq 1
                echo "Active provider: $active (model: $dm)"
            else
                echo "Active provider: $active"
            end
        else
            echo "Active provider: (none)"
        end
        echo "1) Manage providers"
        echo "2) Add new provider"
        echo "q) Quit"
        read -P '> ' -l choice
        switch $choice
            case 1
                _cs_manage_menu
            case 2
                _cs_add_provider
            case q Q
                break
            case '*'
                echo "Invalid choice."
        end
    end
end

_cs_init
_cs_main_menu
