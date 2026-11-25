import ballerina/file;
import ballerina/io;

public function main() returns error? {
    check file:createDir("work/nested", file:RECURSIVE);
    check file:create("work/a.txt");
    file:Error? created = file:create("work/a.txt");
    io:println(created is file:InvalidOperationError);
    check io:fileWriteString("work/a.txt", "content");

    check file:copy("work/a.txt", "work/b.txt");
    file:Error? copied = file:copy("work/a.txt", "work/b.txt");
    io:println(copied is file:InvalidOperationError);
    check io:fileWriteString("work/b.txt", "longer than content");
    check file:copy("work/a.txt", "work/b.txt", file:REPLACE_EXISTING);
    io:println(check io:fileReadString("work/b.txt"));

    check file:rename("work/b.txt", "work/nested/c.txt");
    file:Error? renamed = file:rename("work/a.txt", "work/nested/c.txt");
    io:println(renamed is file:InvalidOperationError);

    check file:copy("work", "copy");
    file:Error? intoItself = file:copy("work", "work/nested/work");
    io:println(intoItself is file:Error);
    io:println(check io:fileReadString("copy/nested/c.txt"));

    file:MetaData[] & readonly entries = check file:readDir("work");
    foreach file:MetaData entry in entries {
        io:println(check file:basename(entry.absPath), " ", entry.dir, " ", entry.readable, " ", entry.writable);
    }

    string absolute = check file:getAbsolutePath("work/a.txt");
    io:println(absolute == check file:joinPath(file:getCurrentDir(), "work", "a.txt"));
    io:println(check io:fileReadString(absolute));

    string temp = check file:createTemp(".txt", "pre");
    check io:fileWriteString(temp, "temp");
    io:println(check io:fileReadString(temp));
    check file:remove(temp);
    string tempDir = check file:createTempDir();
    io:println(check file:test(tempDir, file:IS_DIR));
    check file:remove(tempDir);

    file:Error? removed = file:remove("work");
    io:println(removed is file:FileSystemError);
    check file:remove("work", file:RECURSIVE);
    check file:remove("copy", file:RECURSIVE);
    io:println(check file:test("work", file:EXISTS));
    io:println(file:remove("missing") is file:FileNotFoundError);
    io:println(file:create("") is file:Error);

    file:Error? attributes = file:copy("main.bal", "main2.bal", file:COPY_ATTRIBUTES);
    io:println(attributes is file:Error ? attributes.message() : "copied");
}
