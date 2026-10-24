tell application "Terminal"
    set windowIds to id of every window
    repeat with windowId in windowIds
        set candidateId to windowId as integer
        set tabCount to count of tabs of window id candidateId
        repeat with tabIndex from 1 to tabCount
            if busy of tab tabIndex of window id candidateId is false then
                set tabContent to contents of tab tabIndex of window id candidateId
                if tabContent contains "terminal-smoke-output.txt" then
                    close window id candidateId
                    exit repeat
                end if
            end if
        end repeat
    end repeat
end tell
