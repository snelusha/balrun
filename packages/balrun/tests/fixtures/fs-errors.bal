import ballerina/io;

public function main() {
    foreach string path in ["missing.txt", "dir", "denied.txt", "broken.txt", "thrown.txt"] {
        string|io:Error result = io:fileReadString(path);
        io:println(result is io:Error ? result.message() : result);
    }
    io:Error? result = io:fileWriteString("dir/new.txt", "");
    io:println(result is io:Error ? result.message() : "written");
}
